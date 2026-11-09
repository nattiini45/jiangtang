import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { authenticatePersonalAccessToken } from "~/domains/api-tokens/api-tokens.server";
import { createMcpServer } from "./server.server";
import type { McpContext } from "./types.server";

export const MCP_RATE_LIMIT = 120;
export const MCP_RATE_WINDOW_MS = 60_000;

export function register(app: Express): void {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  const contexts = new WeakMap<Request, McpContext>();
  const json = express.json({ limit: "22mb" });
  const publicUrl = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
  const validateHost = hostHeaderValidation([
    publicUrl.hostname,
    ...(process.env.NODE_ENV !== "production" ? ["localhost", "127.0.0.1", "[::1]"] : []),
  ]);

  app.use("/mcp", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!validateHost(req, res)) return;
    if (req.path !== "/") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== publicUrl.origin) {
      res.status(403).json({ error: "Origin is not allowed" });
      return;
    }
    void (async () => {
      const authorization = req.headers.authorization;
      const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/i);
      const principal = match ? await authenticatePersonalAccessToken(match[1]) : null;
      if (!principal) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="Jiangtang MCP"');
        res.status(401).json({ error: "A valid personal access token is required" });
        return;
      }
      const now = Date.now();
      for (const [id, bucket] of buckets) {
        if (bucket.expiresAt <= now) buckets.delete(id);
      }
      const bucket = buckets.get(principal.token.id) ?? {
        count: 0,
        expiresAt: now + MCP_RATE_WINDOW_MS,
      };
      buckets.set(principal.token.id, bucket);
      if (++bucket.count > MCP_RATE_LIMIT) {
        res.setHeader("Retry-After", Math.ceil((bucket.expiresAt - now) / 1000));
        res.status(429).json({ error: "Token rate limit exceeded" });
        return;
      }
      contexts.set(req, principal);
      next();
    })().catch(() => {
      res.status(500).json({ error: "MCP authentication failed" });
    });
  });

  app.post("/mcp", json, (req, res) => {
    const context = contexts.get(req);
    if (!context) {
      res.status(401).end();
      return;
    }
    const handler = createMcpHandler(() => createMcpServer(context), {
      responseMode: "auto",
      maxSubscriptions: 0,
      keepAliveMs: 0,
    });
    res.on("close", () => {
      void handler.close().catch(() => undefined);
    });
    void toNodeHandler(handler)(req, res, req.body).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
      else res.end();
    });
  });

  app.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Use Streamable HTTP POST requests" });
  });

  app.use("/mcp", (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status === 413 ? 413 : 400;
    res
      .status(status)
      .json({ error: status === 413 ? "Request body is too large" : "Invalid JSON body" });
  });
}
