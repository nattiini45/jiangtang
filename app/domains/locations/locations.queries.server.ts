import { db, type Tx } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import type { Location } from "~/generated/prisma/client";
import type { LocationKind } from "~/generated/prisma/enums";

/**
 * Locations-domain queries. Single-row reads and the reference counts
 * the mutations need; the hierarchical walk lives in `locations.tree.server.ts`.
 *
 * Nothing here writes, so no transaction is opened — every mutating caller opens its
 * own through `txWithAudit`.
 */

/** One node, or `null`. */
export async function getLocation(id: string): Promise<Location | null> {
  return db.location.findUnique({ where: { id } });
}

/** Like {@link getLocation} but throws — for callers that cannot continue without it. */
export async function requireLocation(id: string): Promise<Location> {
  const location = await getLocation(id);
  if (!location) throw new NotFoundError(tr("places.err.location.notFound"));
  return location;
}

/** Direct children of a node (depth 1 only — the whole subtree is `listLocationTree`). */
export async function listChildLocations(parentId: string | null): Promise<Location[]> {
  return db.location.findMany({
    where: parentId === null ? { parentId: null } : { parentId },
    orderBy: { name: "asc" },
  });
}

/** The roots of the forest, i.e. everything a top-level picker can offer. */
export async function listRootLocations(kind?: LocationKind): Promise<Location[]> {
  return db.location.findMany({
    where: { parentId: null, ...(kind ? { kind } : {}) },
    orderBy: { name: "asc" },
  });
}

/** Every node of one kind, flat, for a `<select>` of possible parents. */
export async function listLocationsByKind(kind: LocationKind): Promise<Location[]> {
  return db.location.findMany({ where: { kind }, orderBy: { name: "asc" } });
}

/** `{id, name}` of every location, flat — for pickers like the task form's. */
export function listLocationOptions() {
  return db.location.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

export interface LocationReferenceCounts {
  /** Direct children — the self-reference. `Restrict`, so this is a hard block. */
  children: number;
  /** Inbound references from the four families gives a nullable `locationId`. */
  inventoryItems: number;
  tasks: number;
  notes: number;
  vendors: number;
}

export const EMPTY_REFERENCE_COUNTS: LocationReferenceCounts = {
  children: 0,
  inventoryItems: 0,
  tasks: 0,
  notes: 0,
  vendors: 0,
};

/**
 * How many rows point at this location, counted on the given transaction.
 *
 * `children` is what `deleteLocation` refuses on. The other four are `SetNull`
 * (*"An item whose place was retired is not deleted"*) — the database nulls
 * them, so the domain's job is to *count and record* the consequence, not to block it.
 */
export async function countLocationReferences(
  tx: Tx,
  id: string,
): Promise<LocationReferenceCounts> {
  const [children, inventoryItems, tasks, notes, vendors] = await Promise.all([
    tx.location.count({ where: { parentId: id } }),
    tx.inventoryItem.count({ where: { locationId: id } }),
    tx.task.count({ where: { locationId: id } }),
    tx.note.count({ where: { locationId: id } }),
    tx.vendor.count({ where: { locationId: id } }),
  ]);
  return { children, inventoryItems, tasks, notes, vendors };
}

export function totalReferences(counts: LocationReferenceCounts): number {
  return counts.children + counts.inventoryItems + counts.tasks + counts.notes + counts.vendors;
}
