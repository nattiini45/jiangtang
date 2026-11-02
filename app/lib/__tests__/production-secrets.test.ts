import { describe, expect, it } from "vitest";
import { assertProductionSecrets } from "~/lib/auth.boot.server";

/**
 * Production boot refuses guessable secrets. The env is passed explicitly, so the
 * test does not depend on what the developer's shell or .env exports.
 */

const STRONG_SECRET = "0123456789abcdef0123456789abcdef"; // exactly 32 characters
const HEX_FEED_TOKEN = "f".repeat(64); // the shape `openssl rand -hex 32` produces

describe("assertProductionSecrets", () => {
  it("accepts a 32-character BETTER_AUTH_SECRET with no feed token", () => {
    expect(() => assertProductionSecrets({ BETTER_AUTH_SECRET: STRONG_SECRET })).not.toThrow();
  });

  it("accepts a generated feed token of 32 or more characters", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ICAL_FEED_TOKEN: HEX_FEED_TOKEN,
      }),
    ).not.toThrow();
  });

  it("refuses an unset BETTER_AUTH_SECRET", () => {
    expect(() => assertProductionSecrets({})).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("refuses a BETTER_AUTH_SECRET one character short of 32", () => {
    expect(() => assertProductionSecrets({ BETTER_AUTH_SECRET: STRONG_SECRET.slice(1) })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("refuses a long BETTER_AUTH_SECRET that starts with the change-me placeholder", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: "change-me-generate-a-long-random-string",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("refuses an ICAL_FEED_TOKEN shorter than 32 characters", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ICAL_FEED_TOKEN: "short-feed-token",
      }),
    ).toThrow(/ICAL_FEED_TOKEN/);
  });

  it("refuses the .env.example feed-token placeholder", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ICAL_FEED_TOKEN: "generate-a-long-random-token-here",
      }),
    ).toThrow(/ICAL_FEED_TOKEN/);
  });

  it("treats an empty ICAL_FEED_TOKEN as disabled, not as a weak token", () => {
    expect(() =>
      assertProductionSecrets({ BETTER_AUTH_SECRET: STRONG_SECRET, ICAL_FEED_TOKEN: "" }),
    ).not.toThrow();
  });

  it("accepts an unset or empty ADMIN_PASSWORD", () => {
    expect(() => assertProductionSecrets({ BETTER_AUTH_SECRET: STRONG_SECRET })).not.toThrow();
    expect(() =>
      assertProductionSecrets({ BETTER_AUTH_SECRET: STRONG_SECRET, ADMIN_PASSWORD: "" }),
    ).not.toThrow();
  });

  it("accepts a strong ADMIN_PASSWORD", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ADMIN_PASSWORD: "correct-horse-battery-staple",
      }),
    ).not.toThrow();
  });

  it("refuses the .env.example ADMIN_PASSWORD placeholder", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ADMIN_PASSWORD: "change-me-a-strong-password",
      }),
    ).toThrow(/ADMIN_PASSWORD/);
  });

  it("refuses any ADMIN_PASSWORD that starts with the change-me placeholder prefix", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ADMIN_PASSWORD: "change-me-now",
      }),
    ).toThrow(/ADMIN_PASSWORD/);
  });

  it("does not refuse an ADMIN_PASSWORD that only contains change-me after the start", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ADMIN_PASSWORD: "not-a-change-me-value",
      }),
    ).not.toThrow();
  });

  it("refuses an ADMIN_PASSWORD one character shorter than the Better Auth minimum", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ADMIN_PASSWORD: "abcdefg",
      }),
    ).toThrow(/ADMIN_PASSWORD must be at least 8 characters/);
  });

  it("accepts an ADMIN_PASSWORD of exactly the Better Auth minimum", () => {
    expect(() =>
      assertProductionSecrets({
        BETTER_AUTH_SECRET: STRONG_SECRET,
        ADMIN_PASSWORD: "abcdefgh",
      }),
    ).not.toThrow();
  });
});
