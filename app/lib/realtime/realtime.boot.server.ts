import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { auth } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { broker } from "~/lib/realtime/listener.server";
import { CHECK_TIMEOUT_MS, checkWithTimeout, startSseStream } from "~/lib/realtime/sse.server";

/**
 * Re-checked on every heartbeat of an open stream. An erased account is scrubbed
 * and deactivated (isActive=false), so it ends the stream like any inactive
 * account. A missing row is treated as inactive too, defensively.
 */
async function isUserActive(userId: string): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  return row?.isActive === true;
}

/**
 * Boots the realtime consumer. Discovered by the filesystem
 * boot-loader (`app/server/boot.ts`); runs before the React Router catch-all.
 *
 * - Starts the shared LISTEN broker (one `pg` client, idempotent).
 * - Mounts an auth-gated SSE endpoint at `/api/realtime`. Anonymous or
 *   deactivated users get 401 so an open `EventSource` reconnects/polling never
 *   silently streams data to an unauthenticated browser. Open streams are
 *   re-checked on each heartbeat and end once the account is inactive or gone.
 * - Closes the broker on server shutdown so the process exits cleanly.
 */
export async function register(app: Express, ctx: BootContext): Promise<void> {
  // Begin listening before accepting SSE connections. Safe across HMR reloads
  // (ensureStarted is idempotent and the broker is a globalThis singleton).
  await broker.ensureStarted();

  app.get("/api/realtime", async (req, res) => {
    // A client that disconnects during the session lookup emits 'close' before
    // startSseStream attaches its own listener, which would then never run and
    // would leave the ping interval and broker subscription behind. The flag is
    // set here, before the await, so every branch below can see it.
    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    // Better Auth expects a Web Headers; Express gives us IncomingHttpHeaders,
    // whose values may be string[]. Normalize into a plain record.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    let session: Awaited<ReturnType<typeof auth.api.getSession>>;
    try {
      // A lookup that stalls without rejecting (a lock wait, a half-open
      // connection) is bounded too, so it takes the same retry path.
      session = await checkWithTimeout(
        () => auth.api.getSession({ headers: new Headers(headers) }),
        CHECK_TIMEOUT_MS,
      );
    } catch (err) {
      // A database outage must not leave the request unanswered. A 500 from the
      // error handler would make EventSource give up for good, so the stream
      // answers 200 with a retry hint and the browser reconnects once the
      // database is back.
      console.error("[realtime] session lookup failed:", (err as Error).message);
      if (closed) return;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      });
      res.end("retry: 5000\n\n");
      return;
    }
    if (closed) return;
    if (!session?.user || session.user.isActive === false) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
    const userId = session.user.id;
    startSseStream(req, res, () => isUserActive(userId));
  });

  // Clean shutdown: close the LISTEN client. Registered as an AWAITED shutdown
  // hook so `client.end()` completes before the process exits, rather than
  // leaving the pg socket for the OS to reap (a fire-and-forget `close` listener
  // would be preempted by process.exit).
  ctx.onShutdown(() => broker.stop());
}
