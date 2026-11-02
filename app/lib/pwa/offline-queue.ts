import * as React from "react";
import { UNSAFE_decodeViaTurboStream } from "react-router";

/**
 * Offline capture queue — client module. When a mobile capture submit
 * fails because the network is down, the form fields are stored under a
 * client-generated id (`clientId`, also the future row's primary key — the
 * domain creates are idempotent on it) and replayed on the next `online`
 * event / shell mount.
 *
 * Storage is behind `OfflineQueueStore`: IndexedDB in the browser, an
 * in-memory implementation for unit tests — no new dependency.
 *
 * Replay rules:
 *   2xx                    → remove (a retried create is deduped by clientId)
 *   4xx validation refusal → KEEP, with the server's error on the entry
 *   5xx / network error    → KEEP, retry on the next pass
 *
 * Every POST targets the route's `.data` URL. A POST to the route *path* is a
 * document request: React Router runs the action and then renders the route
 * document, so the action's own payload never reaches `fetch`. Only `.data`
 * data requests return the action result — encoded with React Router's
 * single-fetch framing (`text/x-script`), which `readActionPayload` decodes.
 * The stored/visible `entry.url` stays the surface path; the queue UI filters
 * entries by it.
 */

export interface QueuedCapture {
  /** Dedupe key AND the entity's future id — cuid-shaped (`c` + hex). */
  clientId: string;
  /** POST target, e.g. `/m/tasks/new`. */
  url: string;
  fields: Record<string, string>;
  createdAt: number;
  /** Last refusal message (a 4xx the user must resolve or discard). */
  error?: string;
}

export interface OfflineQueueStore {
  list(): Promise<QueuedCapture[]>;
  put(entry: QueuedCapture): Promise<void>;
  remove(clientId: string): Promise<void>;
}

/** In-memory store — unit tests and the non-DOM fallback. */
export class MemoryQueueStore implements OfflineQueueStore {
  private entries = new Map<string, QueuedCapture>();
  async list(): Promise<QueuedCapture[]> {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(entry: QueuedCapture): Promise<void> {
    this.entries.set(entry.clientId, entry);
  }
  async remove(clientId: string): Promise<void> {
    this.entries.delete(clientId);
  }
}

const DB_NAME = "jiangtang-offline";
const STORE = "captures";

/** IndexedDB store — one object store keyed by `clientId`. */
export class IdbQueueStore implements OfflineQueueStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "clientId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) {
    const db = await this.db();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async list(): Promise<QueuedCapture[]> {
    const all = await this.run("readonly", (s) => s.getAll() as IDBRequest<QueuedCapture[]>);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(entry: QueuedCapture): Promise<void> {
    await this.run("readwrite", (s) => s.put(entry));
  }
  async remove(clientId: string): Promise<void> {
    await this.run("readwrite", (s) => s.delete(clientId));
  }
}

export function defaultStore(): OfflineQueueStore {
  return typeof indexedDB !== "undefined" ? new IdbQueueStore() : new MemoryQueueStore();
}

/** `c` + 24 hex chars — matches the cuid shape the domains enforce. */
export function newClientId(): string {
  return `c${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/** Fired after every queue mutation so badges/lists can re-read the store. */
export const QUEUE_CHANGED_EVENT = "jiangtang:offline-queue-changed";

function notifyChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT));
  }
}

/** Header marking a queue/capture POST — capture actions answer it with JSON. */
export const CAPTURE_HEADER = "x-jiangtang-capture";

export interface CaptureResult {
  state: "sent" | "queued" | "refused";
  /** Server refusal text when `state === "refused"`. */
  error?: string;
  clientId: string;
  /** The created row's id when the action answered JSON (`{ id }`). */
  id?: string;
}

/**
 * Submit a capture form now, or queue it when the network is down. `fields`
 * are the form's serialised fields; `clientId` is added by this function —
 * callers do not set it.
 */
export async function captureOrQueue(
  url: string,
  fields: Record<string, string>,
  store: OfflineQueueStore = defaultStore(),
  fetchImpl: typeof fetch = fetch,
): Promise<CaptureResult> {
  const clientId = newClientId();
  const entry: QueuedCapture = { clientId, url, fields, createdAt: Date.now() };
  const outcome = await postEntry(entry, fetchImpl);
  switch (outcome.kind) {
    case "sent":
      return { state: "sent", clientId, id: outcome.id };
    case "refused":
      return { state: "refused", error: outcome.error, clientId };
    case "retry":
      await store.put(entry);
      notifyChanged();
      return { state: "queued", clientId };
  }
}

type PostOutcome =
  | { kind: "sent"; id?: string }
  | { kind: "refused"; error: string }
  | { kind: "retry" };

/** The capture action's own payload, as returned by a `.data` request. */
interface ActionPayload {
  id?: string;
  error?: string;
}

function asActionPayload(value: unknown): ActionPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { id?: unknown; error?: unknown };
  return {
    id: typeof v.id === "string" ? v.id : undefined,
    error: typeof v.error === "string" ? v.error : undefined,
  };
}

/**
 * Read the action payload from a response. `.data` requests answer with React
 * Router's single-fetch framing (`text/x-script` + turbo-stream), whose value
 * is `{ data: <action result> }`; a plain JSON response (unit tests, a
 * resource endpoint) is read as-is. Returns the raw text too, so a 4xx that is
 * not an action payload can still surface a bounded message.
 */
async function readActionPayload(
  res: Response,
): Promise<{ payload: ActionPayload | null; text: string }> {
  const text = await res.text().catch(() => "");
  if (!text) return { payload: null, text };
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/x-script")) {
    try {
      const decoded = await UNSAFE_decodeViaTurboStream(new Response(text).body!, globalThis);
      await decoded.done;
      const envelope = decoded.value as { data?: unknown } | null;
      return { payload: asActionPayload(envelope?.data), text };
    } catch {
      return { payload: null, text };
    }
  }
  try {
    return { payload: asActionPayload(JSON.parse(text)), text };
  } catch {
    return { payload: null, text };
  }
}

async function postEntry(entry: QueuedCapture, fetchImpl: typeof fetch): Promise<PostOutcome> {
  try {
    const body = new URLSearchParams({ ...entry.fields, clientId: entry.clientId });
    // A POST to the route path renders the document; `.data` is the data
    // request that carries the action's result back to `fetch`.
    const dataUrl = entry.url.endsWith(".data") ? entry.url : `${entry.url}.data`;
    const res = await fetchImpl(dataUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        [CAPTURE_HEADER]: "1",
      },
      body,
    });
    if (res.ok || res.redirected) {
      // Capture actions answer the header with `{ id }` — the page needs it to
      // navigate to the new row; a non-JSON 2xx simply counts as sent.
      const { payload } = await readActionPayload(res);
      return { kind: "sent", id: payload?.id };
    }
    if (res.status >= 400 && res.status < 500) {
      const { payload, text } = await readActionPayload(res);
      let error = payload?.error ?? `HTTP ${res.status}`;
      if (!payload?.error) {
        const bounded = text.slice(0, 300);
        if (bounded) error = bounded;
      }
      return { kind: "refused", error };
    }
    return { kind: "retry" };
  } catch {
    // TypeError = network down; anything else is equally retryable.
    return { kind: "retry" };
  }
}

/**
 * Replay every queued capture in creation order. 2xx → remove; 4xx → keep
 * with the server's error stored on the entry; 5xx/network → keep.
 *
 * Both the mobile shell badge and a capture page mount `useOfflineQueue`, so
 * two replays can start in the same tick. They share one in-flight pass:
 * without this, the same entry is POSTed twice and the create races itself.
 */
export function replayQueue(
  store: OfflineQueueStore = defaultStore(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; refused: number; kept: number }> {
  replayInFlight ??= replayQueueOnce(store, fetchImpl).finally(() => {
    replayInFlight = null;
  });
  return replayInFlight;
}

let replayInFlight: Promise<{ sent: number; refused: number; kept: number }> | null = null;

async function replayQueueOnce(
  store: OfflineQueueStore,
  fetchImpl: typeof fetch,
): Promise<{ sent: number; refused: number; kept: number }> {
  let sent = 0;
  let refused = 0;
  let kept = 0;
  for (const entry of await store.list()) {
    // A 4xx-refused entry waits for the user (discard or fix); replaying it on
    // every pass only repeats the same refusal. It stays visible with its error.
    if (entry.error) {
      kept += 1;
      continue;
    }
    const outcome = await postEntry(entry, fetchImpl);
    if (outcome.kind === "sent") {
      await store.remove(entry.clientId);
      sent += 1;
    } else if (outcome.kind === "refused") {
      await store.put({ ...entry, error: outcome.error });
      refused += 1;
    } else {
      kept += 1;
    }
  }
  if (sent + refused > 0) notifyChanged();
  return { sent, refused, kept };
}

/**
 * React side of the queue: the pending count for the shell badge, the entry
 * list for capture pages (refused entries show their error + a discard
 * button), and the two replay triggers — the `online` event and mount.
 * No-op during SSR (`defaultStore` falls back to memory there).
 */
export function useOfflineQueue(storeOverride?: OfflineQueueStore) {
  // `defaultStore()` must not be a default parameter — a fresh instance every
  // render would retrigger the effect deps below on each state update.
  const store = React.useMemo(() => storeOverride ?? defaultStore(), [storeOverride]);
  const [entries, setEntries] = React.useState<QueuedCapture[]>([]);

  const refresh = React.useCallback(async () => {
    setEntries(await store.list());
  }, [store]);

  const discard = React.useCallback(
    async (clientId: string) => {
      await store.remove(clientId);
      notifyChanged();
      await refresh();
    },
    [store, refresh],
  );

  React.useEffect(() => {
    void refresh();
    void replayQueue(store);
    const onOnline = () => void replayQueue(store).then(refresh);
    const onChanged = () => void refresh();
    window.addEventListener("online", onOnline);
    window.addEventListener(QUEUE_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener(QUEUE_CHANGED_EVENT, onChanged);
    };
  }, [store, refresh]);

  return { entries, pending: entries.length, discard, refresh };
}
