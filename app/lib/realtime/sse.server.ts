import { randomUUID } from "node:crypto";
import type { RealtimeEvent } from "~/lib/realtime/events";
import { broker } from "~/lib/realtime/listener.server";

/**
 * Server-Sent Events wiring. One SSE stream per authenticated
 * session; the shared `broker` (listener.server.ts) pushes decoded events.
 * `Last-Event-ID` resume: on connect, the broker replays buffered events newer
 * than the client's last `ts`, so a brief reconnect drops nothing.
 *
 * Used by `realtime.boot.server.ts`, which mounts the Express route before the
 * React Router catch-all.
 */

const PING_INTERVAL_MS = 15_000;

/**
 * Start an SSE stream on `res`. Auth is the caller's responsibility (the boot
 * module gates on a Better Auth session before calling this). Resolves when the
 * connection closes (client disconnect, res close, or error). Sets the sticky
 * headers Caddy/HTTP-2 need to disable buffering.
 */
export function startSseStream(
  req: { headers: Record<string, string | string[] | undefined> },
  res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    write: (chunk: string | Buffer) => boolean;
    on: (event: "close", cb: () => void) => void;
    end: (chunk?: string | Buffer) => void;
  },
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Caddy / nginx must not buffer the stream — flush each event immediately.
    "X-Accel-Buffering": "no",
  });

  // Each connection gets a stable session id for its lifetime so subscribe/
  // unsubscribe line up even after a broker replay.
  const sessionId = randomUUID();

  // Resume: replay anything newer than the client's last event id (the event's
  // `ts`, sent as the SSE `id:` field). Run before subscribing so the buffer
  // snapshot is consistent with the live stream.
  const lastEventIdHeader = req.headers["last-event-id"];
  const lastRaw = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
  const lastTs = lastRaw ? Number(lastRaw) : NaN;

  const send = (ev: RealtimeEvent): void => {
    // id: carries ts so a reconnect via Last-Event-ID resumes from here.
    res.write(`id: ${ev.ts}\n`);
    res.write(`event: change\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  if (Number.isFinite(lastTs)) {
    broker.resumeSince(lastTs, send);
  }

  const unsubscribe = broker.subscribe(sessionId, send);

  // Heartbeat: proxies may drop an idle connection; a `:` comment keeps it alive
  // without producing a client-visible message event.
  const ping = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, PING_INTERVAL_MS);

  const cleanup = (): void => {
    clearInterval(ping);
    unsubscribe();
  };

  res.on("close", cleanup);
}
