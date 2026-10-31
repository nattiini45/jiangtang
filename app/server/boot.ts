import type { Express } from "express";
import type { Server } from "node:http";

/**
 * Context handed to every boot module. Boot modules import shared singletons
 * (db, etc.) directly from their `~/lib/*.server` modules; `ctx` only carries
 * things that exist solely at the server-process level.
 */
export interface BootContext {
  env: "development" | "production";
  /** The raw HTTP server, e.g. for `server.on("upgrade", …)`. */
  server: Server;
  /**
   * Register an async cleanup to run — and be AWAITED — during graceful
   * shutdown (SIGTERM/SIGINT). Use this instead of `server.on("close", …)` for
   * teardown that must complete before the process exits (flush telemetry, close
   * the pg LISTEN client): the shutdown path in `server.ts` awaits every
   * registered hook, whereas a fire-and-forget `close` listener is preempted by
   * `process.exit`. Hooks run concurrently; a throwing/hanging hook can't block
   * the others past the shutdown backstop.
   */
  onShutdown(hook: () => Promise<void> | void): void;
}

export interface BootModule {
  register(app: Express, ctx: BootContext): void | Promise<void>;
  /**
   * Optional ordering hint. Boot modules run in ascending `order`, ties broken
   * by filename. Default is 0 ("middle"). Modules that register Express
   * *middleware* (e.g. request logging, error tracking) must run before
   * modules that register *routes* (e.g. `app.all("/api/auth/*", …)`) —
   * otherwise Express never routes the earlier-mounted route's traffic through
   * middleware added later. Use a negative order (e.g. -10) for
   * middleware-registering modules; leave route-registering modules at the
   * default.
   */
  order?: number;
}

// Filesystem discovery of server-side boot modules. Eager so the matched
// modules are statically included in the SSR build (prod) and share the route
// loaders' module graph (dev) — no hand-maintained registration array.
const modules = import.meta.glob<BootModule>("/app/**/*.boot.server.ts", {
  eager: true,
});

/**
 * Runs every `*.boot.server.ts` module's `register(app, ctx)`. Called once at
 * server start, BEFORE the React Router catch-all, so modules can mount their
 * own Express routes (SSE, calendar feed) and attach upgrade handlers.
 *
 * Order: ascending `order` (default 0), ties broken by filename. This lets
 * middleware-registering modules (observability's request logger, etc.) run
 * before route-registering modules (auth's `/api/auth/*`), so every route
 * sees the middleware regardless of alphabetical filename order.
 */
export async function runBootModules(app: Express, ctx: BootContext): Promise<void> {
  const entries = Object.entries(modules).sort(([fileA, modA], [fileB, modB]) => {
    const orderA = modA.order ?? 0;
    const orderB = modB.order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return fileA.localeCompare(fileB);
  });
  for (const [file, mod] of entries) {
    if (typeof mod.register === "function") {
      await mod.register(app, ctx);
      console.log(`[boot] registered ${file}`);
    }
  }
}
