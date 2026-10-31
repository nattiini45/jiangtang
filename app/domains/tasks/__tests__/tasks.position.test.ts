import { describe, expect, it } from "vitest";
import { Prisma } from "~/generated/prisma/client";
import { positionBetween } from "../tasks.position";

/**
 * `positionBetween` — the pure half of `moveTask`. Decimal arithmetic
 * only: a `toNumber()` round-trip is exactly the drift the `Decimal(20,10)`
 * column was chosen to prevent, so every assertion compares Decimal strings.
 */
const d = (v: string | number) => new Prisma.Decimal(v);

describe("positionBetween", () => {
  it("empty lane (null, null) → 1", () => {
    expect(positionBetween(null, null)!.toString()).toBe("1");
  });

  it("end of lane (prev only) → prev + 1", () => {
    expect(positionBetween(d("4"), null)!.toString()).toBe("5");
    expect(positionBetween(d("1.5"), null)!.toString()).toBe("2.5");
  });

  it("start of lane (next only) → next − 1", () => {
    expect(positionBetween(null, d("4"))!.toString()).toBe("3");
    // Below zero is legal — positions are an order, not an index.
    expect(positionBetween(null, d("0.5"))!.toString()).toBe("-0.5");
  });

  it("between neighbours → the exact midpoint, without float drift", () => {
    expect(positionBetween(d("1"), d("3"))!.toString()).toBe("2");
    expect(positionBetween(d("1"), d("2"))!.toString()).toBe("1.5");
    // The case floats botch: (0.1 + 0.2) / 2 ≠ 0.15 in binary.
    expect(positionBetween(d("0.1"), d("0.2"))!.toString()).toBe("0.15");
  });

  it("a gap under 1e-6 returns null — the caller's rebalance signal", () => {
    expect(positionBetween(d("1"), d("1.0000005"))).toBeNull();
  });

  it("a gap of exactly 1e-6 still yields a midpoint — the bound is strict", () => {
    expect(positionBetween(d("1"), d("1.000001"))!.toString()).toBe("1.0000005");
  });

  it("an inverted pair (next ≤ prev) also returns null", () => {
    expect(positionBetween(d("3"), d("2"))).toBeNull();
    expect(positionBetween(d("2"), d("2"))).toBeNull();
  });
});
