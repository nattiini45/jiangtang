import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { readConfig } from "~/lib/config.server";
import { authenticatePersonalAccessToken } from "~/domains/api-tokens/api-tokens.server";
import { createMcpServer } from "./server.server";
import type { McpContext } from "./types.server";
import { tr } from "~/i18n/request-locale.server";

export const MCP_RATE_LIMIT = 120;
export const MCP_RATE_WINDOW_MS = 60_000;

export function createMcpAdmissionGate() {
  let active = 0;
  const byToken = new Map<string, number>();
  return (tokenId: string) => {
    const tokenActive = byToken.get(tokenId) ?? 0;
    if (active >= 8 || tokenActive >= 4) return null;
    active++;
    byToken.set(tokenId, tokenActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      const remaining = (byToken.get(tokenId) ?? 1) - 1;
      if (remaining === 0) byToken.delete(tokenId);
      else byToken.set(tokenId, remaining);
    };
  };
}

export function register(app: Express): void {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  const contexts = new WeakMap<Request, McpContext>();
  const json = express.json({ limit: "22mb" });
  const admit = createMcpAdmissionGate();
  const publicUrl = new URL(readConfig("BETTER_AUTH_URL") ?? "http://localhost:3000");
  const validateHost = hostHeaderValidation([
    publicUrl.hostname,
    ...(readConfig("NODE_ENV") !== "production" ? ["localhost", "127.0.0.1", "[::1]"] : []),
  ]);

  app.use("/mcp", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!validateHost(req, res)) return;
    if (req.path !== "/") {
      res.status(404).json({ error: tr("err.notFound") });
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== publicUrl.origin) {
      res.status(403).json({ error: tr("err.mcp.origin") });
      return;
    }
    void (async () => {
      const authorization = req.headers.authorization;
      const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/i);
      const principal = match ? await authenticatePersonalAccessToken(match[1]) : null;
      if (!principal) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="Jiangtang MCP"');
        res.status(401).json({ error: tr("err.mcp.tokenRequired") });
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
        res.status(429).json({ error: tr("err.mcp.rateLimit") });
        return;
      }
      contexts.set(req, principal);
      next();
    })().catch(() => {
      res.status(500).json({ error: tr("err.internal") });
    });
  });

  app.post(
    "/mcp",
    (req, res, next) => {
      const context = contexts.get(req);
      const release = context ? admit(context.token.id) : null;
      if (!release) {
        res.setHeader("Retry-After", "1");
        res.status(429).json({ error: tr("err.mcp.busy") });
        return;
      }
      res.once("finish", release);
      res.once("close", release);
      next();
    },
    json,
    (req, res) => {
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
        if (!res.headersSent) res.status(500).json({ error: tr("err.internal") });
        else res.end();
      });
    },
  );

  app.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: tr("err.mcp.postOnly") });
  });

  app.use("/mcp", (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status === 413 ? 413 : 400;
    res
      .status(status)
      .json({ error: tr(status === 413 ? "err.mcp.bodyTooLarge" : "err.mcp.invalidJson") });
  });
}
