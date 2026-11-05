import { describe, expect, it } from "vitest";
import {
  clientIpFromHeaders,
  createLoginThrottle,
  LOGIN_MAX_IP_FAILURES,
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

describe("login throttle: concurrent attempts", () => {
  it("counts every attempt before any answer, so one more is refused", () => {
    const limit = 5;
    const { throttle } = setup({ maxEmailFailures: limit, maxIpFailures: 1000 });
    const attempt = { email: "a@example.test", ip: "203.0.113.7" };
    // All guesses are in flight: none has been answered by succeeded() yet.
    const decisions = Array.from({ length: limit }, () => throttle.begin(attempt));
    expect(decisions.every((decision) => decision.allowed)).toBe(true);
    expect(throttle.begin(attempt).allowed).toBe(false);
  });

  it("keeps the IP count consistent when a success and a failure interleave", () => {
    const { throttle } = setup({ maxIpFailures: 2, maxEmailFailures: 1 });
    const ip = "203.0.113.7";
    const good = { email: "good@example.test", ip };
    const bad = { email: "bad@example.test", ip };

    expect(throttle.begin(good).allowed).toBe(true);
    expect(throttle.begin(bad).allowed).toBe(true);
    // The correct password is answered while the wrong one is still counted.
    throttle.succeeded(good);

    // One failure remains on the IP: one more attempt fits, a further one does not.
    expect(throttle.begin({ email: "c@example.test", ip }).allowed).toBe(true);
    expect(throttle.begin({ email: "d@example.test", ip }).allowed).toBe(false);
    // The failing email stays locked, the succeeded one was cleared.
    expect(throttle.begin({ ...bad, ip: null }).allowed).toBe(false);
    expect(throttle.begin({ ...good, ip: null }).allowed).toBe(true);
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

  it("keeps a locked email through a flood of distinct junk emails", () => {
    const { throttle, advance } = setup({ maxKeys: 5, maxEmailFailures: 2, maxIpFailures: 1000 });
    const target = { email: "target@example.test", ip: null };
    throttle.begin(target);
    throttle.begin(target);
    advance(MINUTE);
    const before = throttle.begin(target);
    expect(before.allowed).toBe(false);

    for (let i = 0; i < 100; i++) {
      throttle.begin({ email: `junk${i}@example.test`, ip: null });
    }

    expect(throttle.size().emails).toBe(5);
    expect(throttle.begin(target)).toEqual(before);
  });

  it("keeps a locked IP through a flood of distinct junk IPs", () => {
    const { throttle } = setup({ maxKeys: 5, maxIpFailures: 2, maxEmailFailures: 1000 });
    const target = { email: null, ip: "203.0.113.7" };
    throttle.begin(target);
    throttle.begin(target);
    const before = throttle.begin(target);
    expect(before.allowed).toBe(false);

    for (let i = 0; i < 100; i++) {
      throttle.begin({ email: null, ip: `198.51.100.${i}` });
    }

    expect(throttle.size().ips).toBe(5);
    expect(throttle.begin(target)).toEqual(before);
  });

  it("evicts a lock that has run out, but not one still running", () => {
    const { throttle, advance } = setup({
      maxKeys: 3,
      maxEmailFailures: 1,
      windowMs: 15 * MINUTE,
    });
    throttle.begin({ email: "old@example.test", ip: null });
    advance(10 * MINUTE);
    throttle.begin({ email: "newer@example.test", ip: null });
    advance(6 * MINUTE);
    // old's window is over, newer is still locked.
    throttle.begin({ email: "x@example.test", ip: null });
    throttle.begin({ email: "y@example.test", ip: null });

    expect(throttle.size().emails).toBe(3);
    expect(throttle.begin({ email: "newer@example.test", ip: null }).allowed).toBe(false);
    expect(throttle.begin({ email: "old@example.test", ip: null }).allowed).toBe(true);
  });

  it("drops the lock that expires soonest when every tracked key is locked", () => {
    const { throttle, advance } = setup({
      maxKeys: 2,
      maxEmailFailures: 2,
      windowMs: 15 * MINUTE,
    });
    const a = { email: "a@example.test", ip: null };
    const b = { email: "b@example.test", ip: null };
    throttle.begin(a);
    advance(1);
    throttle.begin(b);
    advance(1);
    throttle.begin(b);
    advance(1);
    // Both are locked now. a was touched last, so it is the most recent in map
    // order, but its lock still runs out first.
    throttle.begin(a);
    advance(1);
    throttle.begin({ email: "c@example.test", ip: null });

    expect(throttle.size().emails).toBe(2);
    expect(throttle.begin(b).allowed).toBe(false);
    expect(throttle.begin(a).allowed).toBe(true);
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

describe("clientIpFromHeaders: address normalisation", () => {
  const key = (value: string) => clientIpFromHeaders(new Headers({ "x-forwarded-for": value }));

  it("keeps an IPv4 address as it is and drops a port", () => {
    expect(key("203.0.113.7")).toBe("203.0.113.7");
    expect(key("203.0.113.7:54321")).toBe("203.0.113.7");
  });

  it("gives every spelling of addresses in one /64 the same key", () => {
    const spellings = [
      "2001:db8:abcd:12::1",
      "2001:db8:abcd:12:ffff:ffff:ffff:ffff",
      "2001:0DB8:ABCD:0012:0000:0000:0000:0001",
      "2001:DB8:abcd:12::",
      "[2001:db8:abcd:12::5]",
      "[2001:db8:abcd:12::5]:443",
      "2001:db8:abcd:12::1%eth0",
    ];
    const keys = new Set(spellings.map(key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).not.toBe(key("2001:db8:abcd:13::1"));
  });

  it("separates different /64 prefixes, including ones that differ in one group", () => {
    const prefixes = [
      "2001:db8:abcd:12::1",
      "2001:db8:abcd:13::1",
      "2001:db8:abce:12::1",
      "2001:db9:abcd:12::1",
      "2002:db8:abcd:12::1",
      "::1",
      "fe80::1",
    ];
    expect(new Set(prefixes.map(key)).size).toBe(prefixes.length);
  });

  it("treats the loopback and an expanded loopback alike, and brackets as noise", () => {
    expect(key("[::1]")).toBe(key("0:0:0:0:0:0:0:1"));
    expect(key("::1")).toBe(key("[::1]"));
  });

  it("maps IPv4-mapped IPv6 addresses, in dotted and hex form, to the IPv4 key", () => {
    const v4 = key("192.0.2.1");
    expect(v4).toBe("192.0.2.1");
    expect(key("::ffff:192.0.2.1")).toBe(v4);
    expect(key("::FFFF:192.0.2.1")).toBe(v4);
    expect(key("::ffff:c000:0201")).toBe(v4);
    expect(key("::ffff:c000:201")).toBe(v4);
    expect(key("0:0:0:0:0:ffff:c000:201")).toBe(v4);
    expect(key("[::ffff:192.0.2.1]:8080")).toBe(v4);
  });

  it("does not fold other embedded IPv4 forms into an IPv4 key", () => {
    expect(key("::192.0.2.1")).not.toBe(key("192.0.2.1"));
    expect(key("64:ff9b::192.0.2.1")).not.toBe(key("192.0.2.1"));
  });

  it("keys unparseable input on the trimmed raw string, bounded", () => {
    expect(key("  not-an-ip  ")).toBe("not-an-ip");
    expect(key("1.2.3")).toBe("1.2.3");
    expect(key("x".repeat(500))).toBe("x".repeat(64));
    expect(key(":::".repeat(100))!.length).toBeLessThanOrEqual(64);
  });
});

describe("login throttle: IPv6 client address ranges", () => {
  const fromHeader = (value: string) =>
    clientIpFromHeaders(new Headers({ "x-forwarded-for": value }));

  it("trips the IP limit for failures spread across one /64", () => {
    const { throttle } = setup({ maxEmailFailures: 1000 });
    const ipFor = (i: number) =>
      fromHeader(`2001:db8:abcd:12:${i.toString(16)}::${i.toString(16)}`);
    for (let i = 0; i < LOGIN_MAX_IP_FAILURES; i++) {
      expect(throttle.begin({ email: `user${i}@example.test`, ip: ipFor(i) }).allowed).toBe(true);
    }
    expect(throttle.begin({ email: "fresh@example.test", ip: ipFor(9999) }).allowed).toBe(false);
    expect(throttle.size().ips).toBe(1);
    // Another /64 is unaffected.
    const other = fromHeader("2001:db8:abcd:13::1");
    expect(throttle.begin({ email: "fresh@example.test", ip: other }).allowed).toBe(true);
  });

  it("counts an IPv4-mapped client together with its plain IPv4 form", () => {
    const { throttle } = setup({ maxIpFailures: 2, maxEmailFailures: 100 });
    const plain = fromHeader("192.0.2.1");
    const mapped = fromHeader("::ffff:c000:201");
    expect(throttle.begin({ email: "a@example.test", ip: plain }).allowed).toBe(true);
    expect(throttle.begin({ email: "b@example.test", ip: mapped }).allowed).toBe(true);
    expect(throttle.begin({ email: "c@example.test", ip: plain }).allowed).toBe(false);
  });
});
