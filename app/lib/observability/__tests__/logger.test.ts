import { describe, expect, it } from "vitest";
import { logger, redactTokenSegments, requestLogger } from "~/lib/observability/logger.server";

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
        DATABASE_URL: "synthetic-database-url",
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

describe("request-log URL redaction", () => {
  const FEED_TOKEN = "synthetic-feed-token-0123456789";
  const INVITE_TOKEN = "synthetic-invite-token-abcdef";

  it("replaces the iCal feed token segment and keeps the rest of the path", () => {
    const redacted = redactTokenSegments(`/calendar/${FEED_TOKEN}/ics`);
    expect(redacted).toBe("/calendar/:token/ics");
    expect(redacted).not.toContain(FEED_TOKEN);
  });

  it("replaces the invite token segment", () => {
    const redacted = redactTokenSegments(`/accept-invite/${INVITE_TOKEN}`);
    expect(redacted).toBe("/accept-invite/:token");
    expect(redacted).not.toContain(INVITE_TOKEN);
  });

  it("replaces the password reset token segment, including the route data request", () => {
    const token = "synthetic-reset-token-0123abcd";
    expect(redactTokenSegments(`/reset-password/${token}`)).toBe("/reset-password/:token");
    expect(redactTokenSegments(`/reset-password/${token}.data`)).toBe("/reset-password/:token");
  });

  it("redacts the token when the route prefix is upper or mixed case", () => {
    // React Router matches route paths case-insensitively, so these reach the same handlers.
    const upper = redactTokenSegments(`/CALENDAR/${FEED_TOKEN}/ics`);
    expect(upper).toBe("/CALENDAR/:token/ics");
    expect(upper).not.toContain(FEED_TOKEN);

    const mixed = redactTokenSegments(`/Accept-Invite/${INVITE_TOKEN}`);
    expect(mixed).toBe("/Accept-Invite/:token");
    expect(mixed).not.toContain(INVITE_TOKEN);
  });

  it("keeps the query string of a token-bearing URL", () => {
    expect(redactTokenSegments(`/calendar/${FEED_TOKEN}/ics?x=1`)).toBe("/calendar/:token/ics?x=1");
  });

  it("leaves unrelated paths untouched", () => {
    expect(redactTokenSegments("/healthz")).toBe("/healthz");
    expect(redactTokenSegments("/events/calendar-view?page=2")).toBe(
      "/events/calendar-view?page=2",
    );
  });
});
