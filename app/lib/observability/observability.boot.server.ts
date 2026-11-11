import type { Express } from "express";
import { randomUUID } from "node:crypto";
import type { BootContext } from "~/server/boot";
import { logger, redactTokenSegments } from "~/lib/observability/logger.server";
import { initSentry, captureException, flushSentry } from "~/lib/observability/sentry.server";
import { buildInfo } from "~/lib/version.server";

/**
 * Observability boot. Registers structured request logging
 * + error tracking before the React Router catch-all. Wires the process-level
 * handlers so unhandled rejections / the HTTP server's bind error reach both the
 * logger and GlitchTip.
 *
 * This is the sanctioned extension point — `server.ts` itself is never edited.
 */

// this module registers Express *middleware* (the request logger below),
// which must be attached before any other boot module registers *routes*
// (e.g. auth's `app.all("/api/auth/{*splat}", …)`) — otherwise Express never routes
// that earlier-mounted traffic through this middleware. Negative order runs
// before the default (0).
export const order = -10;

export async function register(app: Express, ctx: BootContext): Promise<void> {
  logger.info(buildInfo, "application boot");
  initSentry();

  // Request logging: stamp each request with an id, log on finish with status + duration.
  app.use((req, res, next) => {
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const start = Date.now();
    res.setHeader("x-request-id", requestId);

    res.on("finish", () => {
      const duration = Date.now() - start;
      const log = logger.child({
        requestId,
        method: req.method,
        url: redactTokenSegments(req.url),
      });
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      log[level]({ statusCode: res.statusCode, durationMs: duration }, "request");
    });

    next();
  });

  // Process-level: route uncaught failures to both the logger and GlitchTip.
  process.on("unhandledRejection", (reason) => {
    captureException(reason);
    logger.error({ reason }, "unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    captureException(error);
    logger.error({ err: error }, "uncaughtException");
    // Node docs: after an uncaughtException the process is in an undefined state
    // and must not keep serving — continuing could mask the audit / no-double-
    // booking guarantees behind a half-broken process. Flush telemetry, then exit
    // non-zero so the supervisor (the container platform) restarts a clean process. An
    // unref'd backstop guarantees exit even if the flush hangs.
    setTimeout(() => process.exit(1), 3_000).unref();
    void flushSentry().finally(() => process.exit(1));
  });

  // Flush Sentry on shutdown so in-flight events are delivered. Registered as an
  // AWAITED shutdown hook (not a fire-and-forget `close` listener) so the ~2s
  // flush completes before the process exits.
  ctx.onShutdown(() => flushSentry());
}
