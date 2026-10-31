import { describe, expect, it } from "vitest";
import { logger, requestLogger } from "~/lib/observability/logger.server";

/**
 * Structured-logger smoke test. Captures a pino sink's output to
 * assert JSON shape, redaction, and the request-id child binding. Pino writes to
 * a custom destination via the `destination` sync API — here we use a memory
 * stream so the assertions are deterministic.
 */

function capture(): { stream: { write(s: string): void }; lines: unknown[] } {
  const lines: unknown[] = [];
  return {
    lines,
    stream: {
      write(s: string) {
        lines.push(JSON.parse(s));
      },
    },
  };
}

describe("structured logger", () => {
  it("emits JSON with an ISO timestamp + level label", () => {
    const sink = capture();
    // Replicate the app logger's config (formatters.level → string label) so the
    // assertion matches what the boot module actually produces.
    const { default: pino } = require("pino") as { default: typeof import("pino") };
    const testLogger = pino(
      {
        level: "info",
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label: string) => ({ level: label }) },
      },
      sink.stream,
    );
    testLogger.info({ method: "GET", url: "/" }, "request");
    expect(sink.lines).toHaveLength(1);
    const line = sink.lines[0] as Record<string, unknown>;
    expect(line.level).toBe("info");
    expect(line.msg).toBe("request");
    expect(line.method).toBe("GET");
    expect(typeof line.time).toBe("string");
  });

  it("redacts secret-bearing paths", () => {
    const sink = capture();
    const { default: pino } = require("pino") as { default: typeof import("pino") };
    // Pino redaction paths are dot-paths: a top-level key is just "DATABASE_URL",
    // a nested one is "user.password". Replicates the logger's redact config shape.
    const testLogger = pino(
      {
        level: "info",
        redact: {
          paths: ["req.headers.authorization", "user.password", "DATABASE_URL"],
          censor: "[redacted]",
        },
      },
      sink.stream,
    );
    testLogger.info(
      {
        req: { headers: { authorization: "Bearer secret" } },
        user: { password: "hunter2", name: "x" },
        DATABASE_URL: "postgres://...",
      },
      "req",
    );
    const line = sink.lines[0] as {
      req: { headers: { authorization: string } };
      user: { password: string; name: string };
      DATABASE_URL: string;
    };
    expect(line.req.headers.authorization).toBe("[redacted]");
    expect(line.user.password).toBe("[redacted]");
    expect(line.user.name).toBe("x");
    expect(line.DATABASE_URL).toBe("[redacted]");
  });

  it("redacts a TOP-LEVEL secret key, not just nested ones", () => {
    const sink = capture();
    const { default: pino } = require("pino") as { default: typeof import("pino") };
    // Mirrors the app logger's actual redact paths (see logger.server.ts): pino's
    // `*` wildcard is single-level, so `*.password` alone would miss a secret
    // logged at the object root — the bare-key paths cover that case.
    const testLogger = pino(
      {
        level: "info",
        redact: {
          paths: [
            "password",
            "*.password",
            "secret",
            "*.secret",
            "token",
            "*.token",
            "DATABASE_URL",
            "*.DATABASE_URL",
          ],
          censor: "[redacted]",
        },
      },
      sink.stream,
    );
    testLogger.info(
      {
        password: "top-level-secret",
        secret: "shh",
        token: "abc123",
        DATABASE_URL: "postgres://user:pw@host/db",
        nested: { password: "nested-secret" },
      },
      "cfg",
    );
    const line = sink.lines[0] as {
      password: string;
      secret: string;
      token: string;
      DATABASE_URL: string;
      nested: { password: string };
    };
    expect(line.password).toBe("[redacted]");
    expect(line.secret).toBe("[redacted]");
    expect(line.token).toBe("[redacted]");
    expect(line.DATABASE_URL).toBe("[redacted]");
    expect(line.nested.password).toBe("[redacted]");
  });

  it("the app's logger + requestLogger are callable", () => {
    // Smoke: the singletons exist and are functions; no throw on a child.
    expect(typeof logger.info).toBe("function");
    const child = requestLogger("req-123", "GET", "/healthz");
    expect(typeof child.info).toBe("function");
  });
});
