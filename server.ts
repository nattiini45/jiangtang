import { createServer as createHttpServer } from "node:http";
import { createRequestHandler } from "@react-router/express";
import express from "express";
import type { Express } from "express";
import type { ViteDevServer } from "vite";
import type { BootContext } from "./app/server/boot";
import { resolveRuntimeMode } from "./app/server/runtime-mode";

// The shape of the React Router server build we rely on (loosely typed: the
// dev build comes from a Vite virtual module that has no static types).
type ServerBuild = {
  entry: { module: { runBootModules: (app: Express, ctx: BootContext) => Promise<void> } };
};

// Load .env before anything reads the environment. Node never overwrites a
// variable that is already set, so exported values and the container environment
// still win over the file. A missing .env is normal (CI and production inject
// the environment directly).
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

// The mode is decided before Express reads NODE_ENV, so every module sees the same
// answer. See resolveRuntimeMode for what an unset or unexpected value means.
const runtime = resolveRuntimeMode(process.env);
const DEVELOPMENT = runtime.development;
process.env.NODE_ENV = runtime.nodeEnv;

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.disable("x-powered-by");

if (runtime.trustProxy !== false) app.set("trust proxy", runtime.trustProxy);

let viteDevServer: ViteDevServer | undefined;
if (DEVELOPMENT) {
  const vite = await import("vite");
  viteDevServer = await vite.createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  app.use(viteDevServer.middlewares);
} else {
  // Fingerprinted assets are immutable; the rest of the client build is short-lived.
  app.use("/assets", express.static("build/client/assets", { immutable: true, maxAge: "1y" }));
  app.use(express.static("build/client", { maxAge: "1h" }));
}

// Dev: load the build through Vite (shares the module graph, enables HMR).
// Prod: import the compiled build. The specifier is widened to `string` so tsc
// does not try to resolve `build/` (which only exists after `react-router build`).
const loadBuild: (() => Promise<unknown>) | ServerBuild = viteDevServer
  ? () => viteDevServer!.ssrLoadModule("virtual:react-router/server-build")
  : ((await import(/* @vite-ignore */ "./build/server/index.js" as string)) as ServerBuild);

const httpServer = createHttpServer(app);

// Resolve the build once to reach runBootModules. Boot modules register their
// own Express routes (SSE, calendar feed, …) and MUST run before the catch-all.
// Async cleanups registered by boot modules (broker.stop, Sentry flush, …).
// Awaited during graceful shutdown so they actually complete before exit.
const shutdownHooks: Array<() => Promise<void> | void> = [];

const build = (typeof loadBuild === "function" ? await loadBuild() : loadBuild) as ServerBuild;
await build.entry.module.runBootModules(app, {
  env: DEVELOPMENT ? "development" : "production",
  server: httpServer,
  onShutdown: (hook) => shutdownHooks.push(hook),
});

app.all(
  "*",
  createRequestHandler({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    build: loadBuild as any,
    mode: DEVELOPMENT ? "development" : "production",
  }),
);

// Fail fast and loud on a bind error (e.g. EADDRINUSE). Without a handler the
// 'error' event becomes an uncaught exception with a raw stack trace; this prints
// an actionable message and exits non-zero (container restart policies see it).
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Jiangtang: port ${PORT} is already in use — set PORT or free it.`);
  } else {
    console.error("Jiangtang: HTTP server error —", err.message);
  }
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Jiangtang ${DEVELOPMENT ? "(dev)" : "(prod)"} → http://localhost:${PORT}`);
});

// Graceful shutdown: SIGTERM (`docker stop`, or the platform's equivalent) and
// SIGINT (Ctrl-C) must close the HTTP server so its 'close' event fires — that
// event is what the realtime boot module listens on to stop the pg LISTEN client,
// and what the observability boot module listens on to flush Sentry. Without
// this, a container stop kills the process before either cleanup runs.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Jiangtang: ${signal} received, shutting down…`);
  // Backstop: never hang past the container's SIGKILL grace. 8s stays safely
  // under Docker's default 10s stop_grace_period, so this "forcing exit" line
  // still lands before the kernel sends SIGKILL. unref() so this timer alone
  // doesn't keep the loop alive once close() + the cleanup hooks have finished.
  const force = setTimeout(() => {
    console.error("Jiangtang: shutdown timed out, forcing exit.");
    process.exit(1);
  }, 8_000);
  force.unref();
  httpServer.close(async (err) => {
    // Run and AWAIT the registered cleanup (broker.stop, Sentry flush) so
    // in-flight events are delivered and the pg LISTEN socket closes cleanly —
    // a fire-and-forget close listener would be preempted by process.exit.
    await Promise.allSettled(shutdownHooks.map((hook) => hook()));
    clearTimeout(force);
    if (err) {
      console.error("Jiangtang: error during shutdown —", err.message);
      process.exit(1);
    }
    process.exit(0);
  });
  // SSE streams are deliberately long-lived (a keep-alive ping holds the socket
  // open indefinitely), so close() would otherwise never fire its callback. Drop
  // open sockets now so shutdown actually proceeds — clients reconnect and
  // self-heal via the reconnect resync. Without this, the shutdown is a no-op under
  // real traffic.
  httpServer.closeAllConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
