import { afterAll, describe, expect, it } from "vitest";
import { requireUser, sanitizeNext } from "~/lib/auth.server";
import { db } from "~/lib/db.server";

/**
 * `sanitizeNext` is the open-redirect guard for the post-login
 * `?next=` round-trip; `requireUser` must bounce anonymous requests to /login with
 * that param preserved (and the whole /m tree is now guarded the same way).
 */

afterAll(async () => {
  await db.$disconnect();
});

describe("sanitizeNext (open-redirect guard)", () => {
  it("accepts local absolute paths (with query)", () => {
    expect(sanitizeNext("/rooms")).toBe("/rooms");
    expect(sanitizeNext("/rooms?q=1&sort=name")).toBe("/rooms?q=1&sort=name");
    expect(sanitizeNext("/")).toBe("/");
  });

  it("rejects protocol-relative, absolute, and backslash URLs", () => {
    expect(sanitizeNext("//evil.com")).toBe("/");
    expect(sanitizeNext("https://evil.com")).toBe("/");
    expect(sanitizeNext("http://evil.com/path")).toBe("/");
    expect(sanitizeNext("/\\evil.com")).toBe("/");
  });

  it("falls back to / for empty or non-absolute values", () => {
    expect(sanitizeNext(null)).toBe("/");
    expect(sanitizeNext(undefined)).toBe("/");
    expect(sanitizeNext("")).toBe("/");
    expect(sanitizeNext("rooms")).toBe("/");
  });

  it("strips control characters before validating, closing the tab-injection bypass", () => {
    // A literal tab between the leading "/" and the second "/" would pass a naive
    // startsWith("//") check, but browsers strip control chars from the Location
    // header, collapsing this to "//evil.com" on the client — an open redirect.
    expect(sanitizeNext("/\t/evil.com")).toBe("/");
    expect(sanitizeNext("/\n//evil.com")).toBe("/");
    expect(sanitizeNext("\t//evil.com")).toBe("/");
    expect(sanitizeNext("/\r/evil.com")).toBe("/");
    // Embedded CR mid-path is stripped rather than left in the returned value,
    // so it can't reconstitute a protocol-relative URL once the browser parses it.
    expect(sanitizeNext("/ro\r/oms?x=1")).toBe("/ro/oms?x=1");

    // A normal path with no control characters is unaffected.
    expect(sanitizeNext("/rooms?x=1")).toBe("/rooms?x=1");
  });
});

describe("requireUser (auth guard)", () => {
  it("redirects an anonymous request to /login with ?next= preserved", async () => {
    const request = new Request("http://localhost/m/scan?x=1");
    try {
      await requireUser(request);
      throw new Error("expected requireUser to throw a redirect");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      const res = thrown as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/m/scan?x=1")}`);
    }
  });
});
