import { describe, expect, it } from "vitest";
import {
  clientIpFromHeaders,
  createLoginThrottle,
  normalizeLoginEmail,
} from "~/lib/login-throttle.server";

const MINUTE = 60_000;

function setup(options: Parameters<typeof createLoginThrottle>[0] = {}) {
  let time = 1_000_000;
  const throttle = createLoginThrottle({ now: () => time, ...options });
  return {
    throttle,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("login throttle: email key", () => {
  it("refuses the attempt after the limit of failures, whatever the password", () => {
    const { throttle } = setup({ maxEmailFailures: 3 });
    const attempt = { email: "a@example.test", ip: null };
    for (let i = 0; i < 3; i++) expect(throttle.begin(attempt).allowed).toBe(true);
    const refused = throttle.begin(attempt);
    expect(refused.allowed).toBe(false);
  });

  it("does not affect other emails", () => {
    const { throttle } = setup({ maxEmailFailures: 1 });
    expect(throttle.begin({ email: "a@example.test", ip: null }).allowed).toBe(true);
    expect(throttle.begin({ email: "a@example.test", ip: null }).allowed).toBe(false);
    expect(throttle.begin({ email: "b@example.test", ip: null }).allowed).toBe(true);
  });

  it("frees up once the oldest failure leaves the rolling window", () => {
    const { throttle, advance } = setup({ maxEmailFailures: 2, windowMs: 15 * MINUTE });
    const attempt = { email: "a@example.test", ip: null };
    throttle.begin(attempt);
    advance(5 * MINUTE);
    throttle.begin(attempt);

    const refused = throttle.begin(attempt);
    // The first failure ages out 10 minutes from now.
    expect(refused).toEqual({ allowed: false, retryAfterMs: 10 * MINUTE });

    advance(10 * MINUTE - 1);
    expect(throttle.begin(attempt).allowed).toBe(false);
    advance(1);
    expect(throttle.begin(attempt).allowed).toBe(true);
  });

  it("does not extend the lockout when a locked key keeps being tried", () => {
    const { throttle, advance } = setup({ maxEmailFailures: 1, windowMs: 15 * MINUTE });
    const attempt = { email: "a@example.test", ip: null };
    throttle.begin(attempt);
    for (let i = 0; i < 20; i++) {
      advance(MINUTE / 2);
      throttle.begin(attempt);
    }
    advance(5 * MINUTE + 1);
    expect(throttle.begin(attempt).allowed).toBe(true);
  });

  it("clears the email's failures after a successful sign-in", () => {
    const { throttle } = setup({ maxEmailFailures: 3 });
    const attempt = { email: "a@example.test", ip: null };
    throttle.begin(attempt);
    throttle.begin(attempt);
    throttle.begin(attempt);
    // The third attempt was the correct password.
    throttle.succeeded(attempt);
    for (let i = 0; i < 3; i++) expect(throttle.begin(attempt).allowed).toBe(true);
    expect(throttle.begin(attempt).allowed).toBe(false);
  });
});

describe("login throttle: IP key", () => {
  it("refuses an IP after its limit, across different emails", () => {
    const { throttle } = setup({ maxIpFailures: 3, maxEmailFailures: 100 });
    for (let i = 0; i < 3; i++) {
      expect(throttle.begin({ email: `user${i}@example.test`, ip: "203.0.113.7" }).allowed).toBe(
        true,
      );
    }
    expect(throttle.begin({ email: "fresh@example.test", ip: "203.0.113.7" }).allowed).toBe(false);
    expect(throttle.begin({ email: "fresh@example.test", ip: "203.0.113.8" }).allowed).toBe(true);
  });

  it("takes back only the successful attempt on the IP, not the other failures", () => {
    const { throttle } = setup({ maxIpFailures: 3, maxEmailFailures: 100 });
    const ip = "203.0.113.7";
    throttle.begin({ email: "a@example.test", ip });
    throttle.begin({ email: "b@example.test", ip });
    throttle.begin({ email: "c@example.test", ip });
    throttle.succeeded({ email: "c@example.test", ip });
    expect(throttle.begin({ email: "d@example.test", ip }).allowed).toBe(true);
    expect(throttle.begin({ email: "e@example.test", ip }).allowed).toBe(false);
  });

  it("skips the IP key when there is none", () => {
    const { throttle } = setup({ maxIpFailures: 1, maxEmailFailures: 100 });
    for (let i = 0; i < 5; i++) {
      expect(throttle.begin({ email: `user${i}@example.test`, ip: null }).allowed).toBe(true);
    }
    expect(throttle.size().ips).toBe(0);
  });

  it("reports the later of the two lockouts", () => {
    const { throttle, advance } = setup({
      maxEmailFailures: 1,
      maxIpFailures: 2,
      windowMs: 15 * MINUTE,
    });
    throttle.begin({ email: "b@example.test", ip: "203.0.113.7" });
    advance(5 * MINUTE);
    throttle.begin({ email: "a@example.test", ip: "203.0.113.7" });
    advance(5 * MINUTE);
    // Email a frees in 10 minutes, the IP in 5.
    const refused = throttle.begin({ email: "a@example.test", ip: "203.0.113.7" });
    expect(refused).toEqual({ allowed: false, retryAfterMs: 10 * MINUTE });
  });
});

describe("login throttle: memory", () => {
  it("caps the number of tracked keys and keeps the most recent ones", () => {
    const { throttle } = setup({ maxKeys: 5, maxEmailFailures: 1, maxIpFailures: 1000 });
    for (let i = 0; i < 50; i++) {
      throttle.begin({ email: `user${i}@example.test`, ip: `198.51.100.${i}` });
    }
    expect(throttle.size()).toEqual({ emails: 5, ips: 5 });
    // The newest key is still tracked, the oldest was dropped.
    expect(throttle.begin({ email: "user49@example.test", ip: null }).allowed).toBe(false);
    expect(throttle.begin({ email: "user0@example.test", ip: null }).allowed).toBe(true);
  });

  it("prunes expired keys instead of keeping them forever", () => {
    const { throttle, advance } = setup({ windowMs: 15 * MINUTE });
    for (let i = 0; i < 100; i++) {
      throttle.begin({ email: `user${i}@example.test`, ip: `198.51.100.${i}` });
    }
    expect(throttle.size()).toEqual({ emails: 100, ips: 100 });
    advance(16 * MINUTE);
    // Any later call sweeps; a different key is enough.
    throttle.begin({ email: "later@example.test", ip: null });
    expect(throttle.size()).toEqual({ emails: 1, ips: 0 });
  });

  it("reset forgets everything", () => {
    const { throttle } = setup({ maxEmailFailures: 1 });
    throttle.begin({ email: "a@example.test", ip: "203.0.113.7" });
    throttle.reset();
    expect(throttle.size()).toEqual({ emails: 0, ips: 0 });
    expect(throttle.begin({ email: "a@example.test", ip: "203.0.113.7" }).allowed).toBe(true);
  });
});

describe("normalizeLoginEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeLoginEmail("  Alice@Example.TEST ")).toBe("alice@example.test");
  });
  it("returns null for blank or non-string input", () => {
    expect(normalizeLoginEmail("   ")).toBeNull();
    expect(normalizeLoginEmail(undefined)).toBeNull();
    expect(normalizeLoginEmail({ email: "x" })).toBeNull();
  });
  it("bounds the key length", () => {
    expect(normalizeLoginEmail("a".repeat(5000))!.length).toBe(320);
  });
});

describe("clientIpFromHeaders", () => {
  it("uses the right-most entry, the hop the trusted proxy appended", () => {
    const headers = new Headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 203.0.113.7" });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.7");
  });
  it("returns null without the header or without an entry", () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": " " }))).toBeNull();
    expect(clientIpFromHeaders(undefined)).toBeNull();
  });
});
