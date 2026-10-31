import { Prisma } from "~/generated/prisma/client";
import type { LocationKind } from "~/generated/prisma/enums";
import { db, type Tx } from "~/lib/db.server";
import type { LocationTreeOptions } from "./locations.schema";

/**
 * The hierarchical walk over `Location` — one recursive CTE, used by
 * both the tree listing and the cycle guard the mutations need.
 *
 * **Two properties this file exists to guarantee, and both are asserted by
 * `__tests__/locations.tree.test.ts`:**
 *
 * 1. **`kind` filters the RESULT, never the TRAVERSAL.** The predicate sits in the
 *    outer `SELECT`, never in the recursive term, so a `ROOM` under a `BUILDING`
 *    still comes back when you ask for `kind: 'ROOM'` — with its real depth, not
 *    the depth it would have in the filtered result. Moving that predicate into the
 *    recursive member is the single most natural edit to this file and it silently
 *    returns nothing, which is why the test names the case.
 *
 * 2. **The walk cannot loop.** `ids` carries the path; the recursive term refuses a
 *    node already on it. Cycle *insertion* is refused by `moveLocation`
 *    (`Restrict`), so this is a backstop for data that
 *    arrived some other way — a hierarchy that loops would hang the query forever.
 *
 * Ordering is depth-first pre-order via `sortPath`, an array of the node names from
 * the root down: a parent always sorts before its children, and siblings sort by
 * name. `id` is the tiebreaker, so two siblings whose names compare equal under the
 * database collation still come back in a fixed order.
 */

export interface LocationTreeNode {
  id: string;
  name: string;
  code: string | null;
  kind: LocationKind;
  address: string | null;
  description: string | null;
  parentId: string | null;
  /** 0 for the node the walk started at (or for each root, in a forest walk). */
  depth: number;
}

export async function listLocationTree(
  options: LocationTreeOptions = {},
): Promise<LocationTreeNode[]> {
  const { parentId, kind } = options;

  // Omitted / null parentId means "the whole forest": every root at depth 0.
  // A given parentId ROOTS the walk AT that node — it comes back at depth 0, with
  // its whole subtree below it. (Anchoring on `parentId = $1` instead would return
  // the node's CHILDREN at depth 0, which is a different function with the same
  // parameter name; `__tests__/locations.tree.test.ts` pins the difference.)
  const anchorFilter = parentId
    ? Prisma.sql`WHERE root.id = ${parentId}`
    : Prisma.sql`WHERE root."parentId" IS NULL`;

  // Result filter, NOT a traversal filter — see the note above.
  const kindFilter = kind ? Prisma.sql`WHERE node.kind::text = ${kind}` : Prisma.empty;

  return db.$queryRaw<LocationTreeNode[]>(Prisma.sql`
    WITH RECURSIVE tree AS (
      SELECT
        root.id,
        root.name,
        root.code,
        root.kind::text AS kind,
        root.address,
        root.description,
        root."parentId",
        0::int AS depth,
        ARRAY[root.name]::text[] AS "sortPath",
        ARRAY[root.id]::text[] AS ids
      FROM "Location" root
      ${anchorFilter}
      UNION ALL
      SELECT
        child.id,
        child.name,
        child.code,
        child.kind::text,
        child.address,
        child.description,
        child."parentId",
        parent.depth + 1,
        parent."sortPath" || child.name,
        parent.ids || child.id
      FROM "Location" child
      JOIN tree parent ON child."parentId" = parent.id
      WHERE NOT (child.id = ANY(parent.ids))
    )
    SELECT id, name, code, kind, address, description, "parentId", depth
    FROM tree node
    ${kindFilter}
    ORDER BY "sortPath", id
  `);
}

/**
 * Is `candidateId` somewhere STRICTLY below `ancestorId`?
 *
 * Walks up from the candidate rather than down from the ancestor, so the walk is
 * bounded by the depth of the candidate rather than by the size of the tree.
 * Runs on the caller's transaction so it sees the same snapshot the mutation is
 * about to write against.
 *
 * The `hops` ceiling is a backstop against a hierarchy that already loops: with
 * the path guard in `listLocationTree` this query would terminate anyway, and
 * `moveLocation` refuses to build such a loop in the first place.
 */
export async function isDescendantWithin(
  tx: Tx,
  ancestorId: string,
  candidateId: string,
  maxHops = 100,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ found: boolean }>>(Prisma.sql`
    WITH RECURSIVE up AS (
      SELECT id, "parentId", 0::int AS hops
      FROM "Location"
      WHERE id = ${candidateId}
      UNION ALL
      SELECT parent.id, parent."parentId", child.hops + 1
      FROM "Location" parent
      JOIN up child ON child."parentId" = parent.id
      WHERE child.hops < ${maxHops}
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE id = ${ancestorId} AND hops > 0) AS found
  `);
  return rows[0]?.found === true;
}
