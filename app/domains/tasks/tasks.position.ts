import { Prisma } from "~/generated/prisma/client";

/**
 * Fractional kanban positions. `Task.position` is `Decimal(20,10)` —
 * Decimal, not Float, so ordering cannot drift when a card is squeezed between
 * two neighbours.
 *
 * **Pure** — no I/O, no server imports beyond the Prisma type/value of Decimal
 * itself; unit-testable in isolation.
 */

/**
 * Below this gap there is no representable midpoint worth writing — the column
 * carries 10 fractional digits, so `1e-6` leaves four digits of headroom while
 * still catching "the neighbours have converged" long before decimal.js runs
 * out of precision on a `(20,10)` column. `null` is the caller's signal to
 * rebalance the lane (renumber 1..n) rather than to keep halving.
 */
const MIN_GAP = new Prisma.Decimal("0.000001");

/**
 * Where a card lands between `prev` (the card it goes after) and `next` (the
 * card it goes before), in lane order:
 *
 * | prev | next | result              |
 * |------|------|---------------------|
 * | null | null | `1` (empty lane)    |
 * | set  | null | `prev + 1` (end)    |
 * | null | set  | `next − 1` (start)  |
 * | set  | set  | midpoint, or `null` when `next − prev < 1e-6` |
 *
 * Decimal arithmetic only — a `toNumber()` round-trip is exactly the drift the
 * column type was chosen to prevent. An inverted pair (`next ≤ prev`) also
 * returns `null`: the caller rebalances, which is the recovery either way.
 */
export function positionBetween(
  prev: Prisma.Decimal | null,
  next: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (prev === null && next === null) return new Prisma.Decimal(1);
  if (prev === null) return next!.sub(1);
  if (next === null) return prev.add(1);
  if (next.sub(prev).lt(MIN_GAP)) return null;
  return prev.add(next).div(2);
}
