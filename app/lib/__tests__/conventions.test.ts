import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveSlug, ensureUniqueSlug } from "~/lib/slug.server";
import { berlinLocalToUtc, utcToBerlinLocal } from "~/lib/time.server";
import {
  BookingConflictError,
  NotFoundError,
  ValidationError,
  isExclusionViolation,
  toErrorResponse,
} from "~/lib/errors.server";

describe("deriveSlug", () => {
  it("transliterates German umlauts and slugifies", () => {
    expect(deriveSlug("Hörsaal 32")).toBe("hoersaal-32");
    expect(deriveSlug("Prüfraum")).toBe("pruefraum");
    expect(deriveSlug("Straße")).toBe("strasse");
  });
  it("normalizes room numbers and punctuation", () => {
    expect(deriveSlug("D.11.23")).toBe("d-11-23");
    expect(deriveSlug("  Demo-Saal  ")).toBe("demo-saal");
    expect(deriveSlug("D.03.35b")).toBe("d-03-35b");
  });
  it("collapses and trims separators", () => {
    expect(deriveSlug("a --  b")).toBe("a-b");
    expect(deriveSlug("--x--")).toBe("x");
  });
});

describe("ensureUniqueSlug", () => {
  it("appends -2, -3 on collision", async () => {
    const taken = new Set(["hoersaal-1", "hoersaal-1-2"]);
    const slug = await ensureUniqueSlug("Hörsaal 1", async (s) => taken.has(s));
    expect(slug).toBe("hoersaal-1-3");
  });
  it("returns the base slug when free", async () => {
    const slug = await ensureUniqueSlug("Neuer Raum", async () => false);
    expect(slug).toBe("neuer-raum");
  });
});

describe("berlin time (DST-correct)", () => {
  it("summer: Berlin is UTC+2", () => {
    // 1 Jul 2026 12:00 Berlin → 10:00 UTC
    expect(berlinLocalToUtc("2026-07-01T12:00").toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });
  it("winter: Berlin is UTC+1", () => {
    // 1 Jan 2026 12:00 Berlin → 11:00 UTC
    expect(berlinLocalToUtc("2026-01-01T12:00").toISOString()).toBe("2026-01-01T11:00:00.000Z");
  });
  it("round-trips through utcToBerlinLocal", () => {
    const local = "2026-03-15T09:30";
    expect(utcToBerlinLocal(berlinLocalToUtc(local))).toBe(local);
  });
  it("picks the right offset across the spring-forward boundary (29 Mar 2026)", () => {
    // Before the 02:00→03:00 jump Berlin is still UTC+1; after it, UTC+2.
    expect(berlinLocalToUtc("2026-03-29T01:30").toISOString()).toBe("2026-03-29T00:30:00.000Z");
    expect(berlinLocalToUtc("2026-03-29T03:30").toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
  it("picks the right offset across the fall-back boundary (25 Oct 2026)", () => {
    // Before the 03:00→02:00 fall-back Berlin is UTC+2; after it, UTC+1.
    expect(berlinLocalToUtc("2026-10-25T01:30").toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(berlinLocalToUtc("2026-10-25T03:30").toISOString()).toBe("2026-10-25T02:30:00.000Z");
  });
});

describe("toErrorResponse mapping", () => {
  it("ZodError → 422", async () => {
    const err = z.object({ a: z.string() }).safeParse({ a: 1 });
    const res = toErrorResponse(err.success ? new Error() : err.error);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("ValidationError");
    expect(body.fieldErrors).toHaveProperty("a");
  });
  it("ValidationError → 422", () => {
    expect(toErrorResponse(new ValidationError({ name: ["Required"] })).status).toBe(422);
  });
  it("BookingConflictError → 409", () => {
    expect(toErrorResponse(new BookingConflictError()).status).toBe(409);
  });
  it("raw SQLSTATE 23P01 → 409", () => {
    expect(toErrorResponse({ code: "23P01" }).status).toBe(409);
  });
  it("NotFoundError → 404", () => {
    expect(toErrorResponse(new NotFoundError("Room")).status).toBe(404);
  });
  it("passes through an existing Response", () => {
    const res = new Response("x", { status: 418 });
    expect(toErrorResponse(res)).toBe(res);
  });
  it("unknown → 500", () => {
    expect(toErrorResponse(new Error("boom")).status).toBe(500);
  });
});

describe("isExclusionViolation", () => {
  it("detects a top-level code", () => {
    expect(isExclusionViolation({ code: "23P01" })).toBe(true);
  });
  it("detects a nested cause", () => {
    expect(isExclusionViolation(new Error("wrapped", { cause: { code: "23P01" } }))).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isExclusionViolation(new Error("nope"))).toBe(false);
    expect(isExclusionViolation({ code: "23505" })).toBe(false);
  });
});
