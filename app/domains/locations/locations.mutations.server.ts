import { NotFoundError, ValidationError, hasSqlState } from "~/lib/errors.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { type Tx } from "~/lib/db.server";
import { tr } from "~/i18n/request-locale.server";
import type { Location } from "~/generated/prisma/client";
import type { LocationCreateInput, LocationEditInput } from "./locations.schema";
import { countLocationReferences, totalReferences } from "./locations.queries.server";
import { isDescendantWithin } from "./locations.tree.server";

/**
 * Locations-domain mutations. Every one of them runs through
 * `txWithAudit`, so the `ActivityLog` row commits with the change or not at all —
 * the append-only audit spine, and the thing `guards.sh` #2 protects.
 *
 * **A refused mutation writes nothing — not the change, and not an audit row**.
 * The audit records what happened, and "nothing happened" is not an event.
 * The four refusals:
 *
 * - deleting a node that still has children (`Restrict`; the child count is
 *   named in the message, and the check is the *handler* — `Restrict` is the backstop
 *   that catches a racing delete, and a raw `P2003` is never allowed to reach a caller);
 * - moving a node under itself;
 * - moving a node under one of its own descendants (`Restrict` covers
 *   deleting a parent and says nothing about moving one, so the same shape is
 *   applied to the other half of the operation — a loop would make the recursive CTE
 *   in `locations.tree.server.ts` run forever);
 * - updating or moving a node that does not exist.
 *
 * **`parentId` is not editable through `updateLocation`.** Reparenting goes through
 * `moveLocation` so that the cycle refusal is the only way the edge ever changes.
 */

/** Postgres `restrict_violation` — the SQLSTATE a `Restrict` FK raises. */
const SQLSTATE_RESTRICT_VIOLATION = "23001";

/** 1 — a parent id that is not a real row. Checked before anything is written. */
async function requireLocationExists(tx: Tx, id: string, field = "parentId"): Promise<Location> {
  const location = await tx.location.findUnique({ where: { id } });
  if (!location) throw new ValidationError({ [field]: [tr("places.err.location.unknown")] });
  return location;
}

export async function createLocation(
  actor: AuditActor,
  input: LocationCreateInput,
): Promise<Location> {
  return txWithAudit(actor, async (tx, audit) => {
    if (input.parentId) await requireLocationExists(tx, input.parentId);
    const location = await tx.location.create({
      data: {
        name: input.name,
        kind: input.kind,
        code: input.code ?? null,
        address: input.address ?? null,
        description: input.description ?? null,
        parentId: input.parentId ?? null,
        createdById: actor?.id ?? null,
      },
    });
    await audit({
      action: "LocationCreated",
      entityType: "location",
      entityId: location.id,
      data: { name: location.name, kind: location.kind, parentId: location.parentId },
    });
    return location;
  });
}

export async function updateLocation(
  actor: AuditActor,
  id: string,
  input: LocationEditInput,
): Promise<Location> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.location.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("places.err.location.notFound"));
    const location = await tx.location.update({
      where: { id },
      data: {
        name: input.name,
        kind: input.kind,
        code: input.code ?? null,
        address: input.address ?? null,
        description: input.description ?? null,
      },
    });
    await audit({
      action: "LocationUpdated",
      entityType: "location",
      entityId: location.id,
      // Only what actually moved — an update that rewrites the same values is not
      // a change worth a second reading in /activity.
      data: {
        from: {
          name: before.name !== location.name ? before.name : undefined,
          kind: before.kind !== location.kind ? before.kind : undefined,
          code: before.code !== location.code ? before.code : undefined,
          address: before.address !== location.address ? before.address : undefined,
          description: before.description !== location.description ? before.description : undefined,
        },
        to: { name: location.name, kind: location.kind, code: location.code },
      },
    });
    return location;
  });
}

/**
 * 2 — delete a node. Refused while it has children, because a subtree must be
 * reparented explicitly. References from stock / tasks / notes / vendors are
 * `SetNull` by the same table, so those are **detached, not blocked** — and their
 * counts go into the audit row, because a delete that silently strips 30 stock items
 * of their place is not something the append-only log should be the only witness of.
 */
export async function deleteLocation(actor: AuditActor, id: string): Promise<Location> {
  return txWithAudit(actor, async (tx, audit) => {
    const location = await tx.location.findUnique({ where: { id } });
    if (!location) throw new NotFoundError(tr("places.err.location.notFound"));

    const counts = await countLocationReferences(tx, id);
    if (counts.children > 0) {
      throw new ValidationError({}, [
        tr("places.err.location.deleteHasChildren", {
          name: location.name,
          count: counts.children,
          children:
            counts.children === 1
              ? tr("places.err.location.child.one")
              : tr("places.err.location.child.other"),
        }),
      ]);
    }

    const detached = totalReferences(counts);
    let deleted: Location;
    try {
      deleted = await tx.location.delete({ where: { id } });
    } catch (error) {
      // Backstop for the race the count cannot close: another writer can attach a
      // child between the COUNT and the DELETE.
      //
      // ⚠️ On THIS stack, with `@prisma/adapter-pg`, a Restrict violation is
      // **not** Prisma's `P2003`. It surfaces as a `DriverAdapterError`
      // carrying SQLSTATE `23001` in `.cause.code`. A
      // handler written against `"P2003"` therefore catches nothing at all — the
      // error a `P2003` check would look for cannot occur here. `hasSqlState` walks
      // the `.cause` chain, so it matches the shape that is actually raised.
      if (hasSqlState(error, SQLSTATE_RESTRICT_VIOLATION)) {
        throw new ValidationError({}, [
          tr("places.err.location.deleteRacedChildren", { name: location.name }),
        ]);
      }
      throw error;
    }
    await audit({
      action: "LocationDeleted",
      entityType: "location",
      entityId: id,
      data: {
        name: location.name,
        kind: location.kind,
        detached: { ...counts, children: 0 },
        detachedTotal: detached,
      },
    });
    return deleted;
  });
}

/**
 * 3 — reparent a node. `parentId: null` promotes it to a root. The whole subtree
 * follows, because the edge is the only thing that changes: a child points at its
 * parent, so moving the parent moves the branch with it.
 */
export async function moveLocation(
  actor: AuditActor,
  id: string,
  newParentId: string | null,
): Promise<Location> {
  return txWithAudit(actor, async (tx, audit) => {
    const location = await tx.location.findUnique({ where: { id } });
    if (!location) throw new NotFoundError(tr("places.err.location.notFound"));

    if (location.parentId === newParentId) {
      throw new ValidationError({ parentId: [tr("places.err.location.alreadyThere")] });
    }

    if (newParentId) {
      if (newParentId === id) {
        throw new ValidationError({
          parentId: [tr("places.err.location.selfParent")],
        });
      }
      const parent = await requireLocationExists(tx, newParentId);
      if (await isDescendantWithin(tx, id, newParentId)) {
        throw new ValidationError({
          parentId: [
            tr("places.err.location.moveIntoSubtree", { parent: parent.name, name: location.name }),
          ],
        });
      }
    }

    const moved = await tx.location.update({ where: { id }, data: { parentId: newParentId } });
    await audit({
      action: "LocationMoved",
      entityType: "location",
      entityId: id,
      data: { name: moved.name, fromParentId: location.parentId, toParentId: newParentId },
    });
    return moved;
  });
}
