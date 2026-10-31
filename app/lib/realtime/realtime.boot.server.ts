import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { auth } from "~/lib/auth.server";
import { broker } from "~/lib/realtime/listener.server";
import { startSseStream } from "~/lib/realtime/sse.server";

/**
 * Boots the realtime consumer. Discovered by the filesystem
 * boot-loader (`app/server/boot.ts`); runs before the React Router catch-all.
 *
 * - Starts the shared LISTEN broker (one `pg` client, idempotent).
 * - Mounts an auth-gated SSE endpoint at `/api/realtime`. Anonymous or
 *   deactivated users get 401 so an open `EventSource` reconnects/polling never
 *   silently streams data to an unauthenticated browser.
 * - Closes the broker on server shutdown so the process exits cleanly.
 */
export async function register(app: Express, ctx: BootContext): Promise<void> {
  // Begin listening before accepting SSE connections. Safe across HMR reloads
  // (ensureStarted is idempotent and the broker is a globalThis singleton).
  await broker.ensureStarted();

  app.get("/api/realtime", async (req, res) => {
    // Better Auth expects a Web Headers; Express gives us IncomingHttpHeaders,
    // whose values may be string[]. Normalize into a plain record.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    const session = await auth.api.getSession({ headers: new Headers(headers) });
    if (!session?.user) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
    startSseStream(req, res);
  });

  // Clean shutdown: close the LISTEN client. Registered as an AWAITED shutdown
  // hook so `client.end()` completes before the process exits, rather than
  // leaving the pg socket for the OS to reap (a fire-and-forget `close` listener
  // would be preempted by process.exit).
  ctx.onShutdown(() => broker.stop());
}
