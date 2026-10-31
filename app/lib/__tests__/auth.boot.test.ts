import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDevAdminEmail } from "~/lib/auth.boot.server";

/**
 * The development bootstrap admin email is env-overridable.
 *
 * This suite imports the REAL module (`~/lib/auth.boot.server`), not a
 * re-implementation of its `??` expression: if the `process.env.DEV_ADMIN_EMAIL`
 * read is removed from `resolveDevAdminEmail`, the override cases below go red.
 *
 * No database is needed: importing the module constructs the Prisma client
 * lazily (no connect until a query) and neither `register` nor `seedDevAdmin`
 * is called here, so no query is ever issued.
 *
 * ENV HYGIENE: the test environment exports DEV_ADMIN_EMAIL, so an inherited
 * value would silently invalidate the default assertion. The
 * unset case therefore deletes the variable explicitly, asserts what the
 * process actually sees, and restores the inherited value in `finally`.
 */

const DEFAULT_LITERAL = "admin@jiangtang.local";

/** Captured at import time so the unset case can put the ambient env back. */
const INHERITED = process.env.DEV_ADMIN_EMAIL;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveDevAdminEmail (dev seed)", () => {
  it("honours a DEV_ADMIN_EMAIL override", () => {
    vi.stubEnv("DEV_ADMIN_EMAIL", "admin@example.test");
    expect(process.env.DEV_ADMIN_EMAIL).toBe("admin@example.test");
    expect(resolveDevAdminEmail()).toBe("admin@example.test");
  });

  it("returns the exact literal admin@jiangtang.local when DEV_ADMIN_EMAIL is unset", () => {
    // Deliberate delete + restore: the test environment exports DEV_ADMIN_EMAIL, so "unset"
    // must be constructed, not assumed.
    delete process.env.DEV_ADMIN_EMAIL;
    try {
      // Assert what the process actually sees before asserting the fallback.
      expect(process.env.DEV_ADMIN_EMAIL).toBeUndefined();
      expect(resolveDevAdminEmail()).toBe(DEFAULT_LITERAL);
    } finally {
      if (INHERITED !== undefined) process.env.DEV_ADMIN_EMAIL = INHERITED;
    }
    // The ambient environment is exactly as this file found it.
    expect(process.env.DEV_ADMIN_EMAIL).toBe(INHERITED);
  });

  it("mirrors the password line's ?? semantics: empty string does NOT fall back", () => {
    // DEV_ADMIN_PASSWORD uses `?? default` (only null/undefined fall back).
    // Pinning the empty-string case fails if the read is ever swapped to `||`.
    vi.stubEnv("DEV_ADMIN_EMAIL", "");
    expect(process.env.DEV_ADMIN_EMAIL).toBe("");
    expect(resolveDevAdminEmail()).toBe("");
  });
});
