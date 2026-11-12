import { db } from "~/lib/db.server";
import type { Prisma } from "~/generated/prisma/client";
import { ENTITY_TYPES, type EntityType } from "~/lib/realtime/events";
import type { AuditActor } from "~/lib/audit.server";
import { timeActivityVisibility } from "~/domains/time/time-access.server";

/**
 * Per-entity activity history. Reads the append-only ActivityLog,
 * which is indexed on (entityType, entityId). Generic by design: the ticket
 * detail page, the room dashboard, and any future entity can render the same
 * feed. Read-only — writes only ever happen through txWithAudit.
 */

/**
 * Every entityType, keyed by its own name, for readers that prefer a named
 * constant over a bare string literal. The map is checked against `ENTITY_TYPES`, so it cannot
 * silently fall behind the vocabulary the writers use.
 *
 * Two guards, one per direction of drift:
 *  - `satisfies Record<string, EntityType>` makes a non-member VALUE a compile
 *    error. This is the direction whose drift would leave rows unreadable.
 *  - the completeness half — a member this map omits — is checked at runtime by
 *    `entity-type-vocabulary.test.ts`, because a `Record` type cannot express
 *    "every key present" without a cast, and a cast would defeat the point.
 *
 * Kebab-case members are camelCased for the key (`inventoryItem`), so the
 * lookup key and the wire value differ for that one member by design.
 */
export const ENTITY_TYPE = {
  campus: "campus",
  building: "building",
  room: "room",
  equipmentModel: "equipmentModel",
  equipmentKind: "equipmentKind",
  equipmentFunctionGroup: "equipmentFunctionGroup",
  customField: "customField",
  listColumns: "listColumns",
  equipment: "equipment",
  ticket: "ticket",
  event: "event",
  eventRoomBooking: "eventRoomBooking",
  equipmentAllocation: "equipmentAllocation",
  serviceWindow: "serviceWindow",
  attachment: "attachment",
  user: "user",
  activityLog: "activityLog",
  location: "location",
  inventoryItem: "inventory-item",
  project: "project",
  task: "task",
  note: "note",
  vendor: "vendor",
  timeEntry: "timeEntry",
  notification: "notification",
  calendarOutbox: "calendarOutbox",
} as const satisfies Record<string, EntityType>;

/** `inventoryItem` → `inventory-item`; every other member keys as itself. */
export function entityTypeKey(entityType: EntityType): keyof typeof ENTITY_TYPE {
  const camel = entityType.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  const key = camel as keyof typeof ENTITY_TYPE;
  if (!(key in ENTITY_TYPE)) {
    throw new Error(
      `entityTypeKey: "${entityType}" has no ENTITY_TYPE key (${ENTITY_TYPES.length} members)`,
    );
  }
  return key;
}

export interface ActivityEntry {
  id: string;
  action: string;
  /**
   * `string`, not `EntityType`, and deliberately so: the column already holds 26
   * distinct spellings from before the vocabulary was typed (they are
   * append-only and cannot be re-spelled), so narrowing the *read* type would
   * be a claim the data does not support.
   */
  entityType: string;
  entityId: string;
  actorSnapshot: Prisma.JsonValue;
  data: Prisma.JsonValue;
  occurredAt: Date;
}

/**
 * ⚠️ **`entityType` is `string` here on purpose, and this is the reader-side
 * half of the vocabulary typing.** The writer was typed (`audit()`); the reader
 * is not, and the reason is a test rather than a matter of style:
 * `listEntityHistory("Room", …)` at `tickets.history.test.ts:87` is the
 * *negative* half of the lowercase-casing contract — it asserts that a wrong
 * casing returns **zero** rows. Typing this parameter with `EntityType` makes
 * that call a compile error, which would mean deleting the one test that proves
 * the reader is right about the writers being wrong. A reader that cannot be
 * asked a wrong question cannot demonstrate that it would answer wrongly, so
 * the wide parameter is the behaviour under test, not a hole in it. That test
 * is the contract for the reader and must not be edited to fit the implementation.
 */
export async function listEntityHistory(
  entityType: string,
  entityId: string,
  limit = 50,
  actor?: AuditActor,
): Promise<ActivityEntry[]> {
  const isTime = entityType.toLowerCase() === "timeentry";
  const visibility = isTime ? await timeActivityVisibility(actor ?? {}) : {};
  const rows = await db.activityLog.findMany({
    where: { entityType, entityId, ...(isTime ? { AND: [visibility] } : {}) },
    orderBy: [{ occurredAt: "desc" }, { insertedAt: "desc" }],
    take: limit,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      actorSnapshot: true,
      data: true,
      occurredAt: true,
    },
  });
  return rows;
}
