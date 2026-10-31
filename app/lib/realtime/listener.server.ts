import { Client } from "pg";
import { REALTIME_CHANNEL, decodeRealtimeEvent, type RealtimeEvent } from "~/lib/realtime/events";

/**
 * Realtime consumer — the shared LISTEN half of the frozen producer
 * (`emitChange`, emit.server.ts). One long-lived `pg.Client` (separate from the
 * Prisma adapter pool, which must never block on a NOTIFY) subscribes to
 * `REALTIME_CHANNEL`, decodes each notification, and fans it out to an in-memory
 * subscriber registry. A short ring buffer of recent events backs `Last-Event-ID`
 * resume for reconnecting SSE clients.
 *
 * Lifecycle: started once by `realtime.boot.server.ts`; closed on server shutdown.
 * Idempotent start: `ensureStarted()` is safe to call repeatedly.
 */

const RING_SIZE = 100;
/** Reconnect backoff: exponential from 1s, capped at 30s. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type Subscriber = (event: RealtimeEvent) => void;

class RealtimeBroker {
  /** `pg` LISTEN client; lazily connected. */
  private client: Client | null = null;
  /** subscribers keyed by an opaque session id (one per SSE connection). */
  private subscribers = new Map<string, Subscriber>();
  /** most-recent-first ring buffer for resume after a dropped connection. */
  private ring: RealtimeEvent[] = [];
  private starting: Promise<void> | null = null;
  /** consecutive failed connect attempts, drives exponential backoff. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** true once `start()` has succeeded at least once (gates the reconnect resync push). */
  private everConnected = false;
  /** set by stop(); suppresses scheduled reconnects after an explicit shutdown. */
  private stopped = false;

  /** Begin listening (no-op if already started). Safe to await from boot. */
  async ensureStarted(): Promise<void> {
    if (this.client || this.starting) return this.starting ?? Promise.resolve();
    this.stopped = false;
    // never let a rejected attempt wedge the broker — reset `starting` (so the
    // next call retries) and schedule a backed-off retry ourselves, but don't let
    // the rejection propagate past this call as a fatal boot-time throw.
    this.starting = this.start().catch((err) => {
      this.starting = null;
      this.client = null;
      console.error("[realtime] listener failed to start:", (err as Error).message);
      this.scheduleReconnect();
    });
    return this.starting;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async start(): Promise<void> {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (realtime listener).");

    const client = new Client({ connectionString: url });
    client.on("error", (err) => {
      // The client surfaces connection-loss here; node-pg auto-reconnects on the
      // next query, but a LISTEN channel dies with the connection — so reconnect
      // explicitly and re-issue LISTEN.
      console.error("[realtime] listener connection error:", err.message);
      this.teardownClient(client);
      // Only clear shared state if this errored client is still the active one
      // (an already-superseded client's error must not clobber a newer connection).
      if (this.client === client) this.client = null;
      this.starting = null;
      // Best-effort reconnect with backoff; if the DB is down this keeps retrying
      // via the same error path until it comes back.
      this.scheduleReconnect();
    });

    await client.connect();
    // this is a fresh successful connect — replace (and clean up) whatever
    // the previous client was, so listeners/sockets never accumulate.
    this.teardownClient(this.client);
    this.client = client;
    this.reconnectAttempts = 0;
    // Parameterized channel name can't be used with LISTEN (it's an identifier),
    // but REALTIME_CHANNEL is a frozen literal — never user input.
    await client.query(`LISTEN ${REALTIME_CHANNEL}`);
    client.on("notification", (msg) => {
      if (msg.channel !== REALTIME_CHANNEL || !msg.payload) return;
      let ev: RealtimeEvent;
      try {
        ev = decodeRealtimeEvent(msg.payload);
      } catch {
        return; // malformed payload — producer contract violation; drop silently
      }
      this.push(ev);
    });
    console.log(`[realtime] listening on "${REALTIME_CHANNEL}"`);

    // NOTIFYs emitted during the gap between drop and re-LISTEN are lost —
    // tell every currently-connected subscriber to refetch so they self-heal past
    // the gap. Only on a *re*connect (not the very first successful start), and
    // fire-and-forget so a throwing subscriber can't fail `start()`.
    if (this.everConnected) {
      this.pushResync();
    }
    this.everConnected = true;
  }

  /** Remove listeners and close a superseded client without blocking the caller. */
  private teardownClient(old: Client | null): void {
    if (!old) return;
    old.removeAllListeners();
    void old.end().catch(() => undefined);
  }

  /**
   * synthetic "refetch now" signal fanned out to every live subscriber after
   * a reconnect, covering NOTIFYs that were lost while disconnected. Reuses the
   * same subscriber callback shape the SSE layer already treats as a refetch
   * trigger (use-live-refetch.ts revalidates on any `change` event) — a
   * `resync`-flagged RealtimeEvent needs no new wire format.
   */
  private pushResync(): void {
    const resync: RealtimeEvent = {
      entityType: "activityLog",
      id: "resync",
      op: "updated",
      ts: Date.now(),
    };
    this.push(resync);
  }

  /** Decode + broadcast + ring-buffer an event. Exposed for tests. */
  private push(ev: RealtimeEvent): void {
    this.ring.unshift(ev);
    if (this.ring.length > RING_SIZE) this.ring.length = RING_SIZE;
    for (const sub of this.subscribers.values()) {
      try {
        sub(ev);
      } catch {
        // a throwing subscriber must not break fan-out to the others
      }
    }
  }

  /** Register a per-session subscriber. Returns an unsubscribe function. */
  subscribe(sessionId: string, fn: Subscriber): () => void {
    this.subscribers.set(sessionId, fn);
    return () => {
      // Only delete if still ours (a re-subscribe with the same id shouldn't
      // tear down a newer subscription).
      if (this.subscribers.get(sessionId) === fn) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  /** Drop a subscriber by id (idempotent). */
  unsubscribe(sessionId: string): void {
    this.subscribers.delete(sessionId);
  }

  /**
   * Replay every buffered event with `ts > lastTs` to a subscriber (newest-first
   * is fine: each carries its own `ts`, and the client treats them only as a
   * refetch trigger — order between distinct entities is irrelevant).
   */
  resumeSince(lastTs: number, fn: Subscriber): void {
    for (const ev of this.ring) {
      if (ev.ts <= lastTs) break;
      try {
        fn(ev);
      } catch {
        return;
      }
    }
  }

  /** Test/debug: current subscriber count. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Shutdown — close the LISTEN client. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const c = this.client;
    this.client = null;
    this.starting = null;
    this.everConnected = false;
    this.reconnectAttempts = 0;
    this.subscribers.clear();
    if (c) {
      c.removeAllListeners();
      try {
        await c.end();
      } catch {
        // already gone
      }
    }
  }
}

/** Process-wide singleton (HMR-safe: cached on globalThis in dev). */
const globalForRealtime = globalThis as unknown as { __jiangtangBroker?: RealtimeBroker };
export const broker: RealtimeBroker = globalForRealtime.__jiangtangBroker ?? new RealtimeBroker();
if (process.env.NODE_ENV !== "production") {
  globalForRealtime.__jiangtangBroker = broker;
}
