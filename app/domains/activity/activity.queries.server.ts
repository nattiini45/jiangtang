import { Prisma } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { entityHref } from "~/lib/entity-links";

/**
 * `/activity` — the global feed. Query-only folder, owns no model
 * (`cross-folder-writes` FOLDERS `[]`); ActivityLog itself is append-only via
 * `txWithAudit` and belongs to `app/lib`.
 *
 * Ordering is `occurredAt DESC, id DESC` — logical time, not insert order, so a
 * back-dated ticket lands where its time says. The cursor encodes the last
 * row's `(occurredAt, id)` pair so pagination never skips or repeats rows that
 * share a timestamp (a `LIMIT/OFFSET` page or a bare `occurredAt < x` cut
 * would do both).
 */

export interface ActivityListOptions {
  actorId?: string;
  entityTypes?: string[];
  cursor?: string;
  limit?: number;
}

export interface ActivityListRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  actorId: string | null;
  actorSnapshot: Prisma.JsonValue;
  /** Resolved display title — the entity's name/title, or the audit row's
   *  `data.title`/`data.name` when the entity is gone, or `#`-short-id. */
  title: string;
  href: string | null;
}

export function encodeActivityCursor(occurredAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([occurredAt.getTime(), id])).toString("base64url");
}

/** A bad cursor degrades to the first page — the list-filter contract. */
export function decodeActivityCursor(
  raw: string | null | undefined,
): { occurredAt: Date; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString()) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "number" || typeof parsed[1] !== "string") {
      return undefined;
    }
    const occurredAt = new Date(parsed[0]);
    return Number.isFinite(occurredAt.getTime()) ? { occurredAt, id: parsed[1] } : undefined;
  } catch {
    return undefined;
  }
}

interface ResolvedEntity {
  id: string;
  title: string;
  slug?: string | null;
}

const byIds = (ids: string[]) => ({ where: { id: { in: ids } } });

/** One batched title+slug lookup per entity type — the feed's N+1 guard. The
 *  types absent here (booking sub-rows, attachment, activityLog…) have no page
 *  and no title column worth a query; they fall through to `data`. */
const ENTITY_LOOKUPS: Record<string, (ids: string[]) => Promise<ResolvedEntity[]>> = {
  task: async (ids) => db.task.findMany({ ...byIds(ids), select: { id: true, title: true } }),
  ticket: async (ids) => db.ticket.findMany({ ...byIds(ids), select: { id: true, title: true } }),
  project: async (ids) =>
    db.project
      .findMany({ ...byIds(ids), select: { id: true, slug: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name, slug: x.slug }))),
  note: async (ids) => db.note.findMany({ ...byIds(ids), select: { id: true, title: true } }),
  location: async (ids) =>
    db.location
      .findMany({ ...byIds(ids), select: { id: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name }))),
  "inventory-item": async (ids) =>
    db.inventoryItem
      .findMany({ ...byIds(ids), select: { id: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name }))),
  equipment: async (ids) =>
    db.equipment
      .findMany({ ...byIds(ids), select: { id: true, name: true, assetTag: true, serial: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name ?? x.assetTag ?? x.serial ?? x.id }))),
  equipmentModel: async (ids) =>
    db.equipmentModel
      .findMany({ ...byIds(ids), select: { id: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name }))),
  event: async (ids) => db.event.findMany({ ...byIds(ids), select: { id: true, title: true } }),
  room: async (ids) =>
    db.room
      .findMany({ ...byIds(ids), select: { id: true, slug: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name, slug: x.slug }))),
  user: async (ids) =>
    db.user
      .findMany({ ...byIds(ids), select: { id: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name }))),
  campus: async (ids) =>
    db.campus
      .findMany({ ...byIds(ids), select: { id: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name }))),
  building: async (ids) =>
    db.building
      .findMany({ ...byIds(ids), select: { id: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name }))),
  vendor: async (ids) =>
    db.vendor
      .findMany({ ...byIds(ids), select: { id: true, name: true } })
      .then((r) => r.map((x) => ({ id: x.id, title: x.name }))),
};

function titleFromData(data: Prisma.JsonValue): string | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (typeof d.title === "string" && d.title) return d.title;
    if (typeof d.name === "string" && d.name) return d.name;
  }
  return null;
}

export async function listActivity(options: ActivityListOptions = {}) {
  const limit = options.limit ?? 50;
  const cursor = decodeActivityCursor(options.cursor);
  const rows = await db.activityLog.findMany({
    where: {
      ...(options.actorId ? { actorId: options.actorId } : {}),
      ...(options.entityTypes?.length ? { entityType: { in: options.entityTypes } } : {}),
      ...(cursor
        ? {
            OR: [
              { occurredAt: { lt: cursor.occurredAt } },
              { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit
      ? encodeActivityCursor(page[page.length - 1].occurredAt, page[page.length - 1].id)
      : null;

  // Resolve display titles in one query per entity type present on the page.
  const idsByType = new Map<string, Set<string>>();
  for (const r of page) {
    const set = idsByType.get(r.entityType) ?? new Set<string>();
    set.add(r.entityId);
    idsByType.set(r.entityType, set);
  }
  const resolved = new Map<string, ResolvedEntity>(); // `${type}:${id}` → entity
  await Promise.all(
    [...idsByType].map(async ([type, ids]) => {
      const lookup = ENTITY_LOOKUPS[type];
      if (!lookup) return;
      for (const e of await lookup([...ids])) {
        resolved.set(`${type}:${e.id}`, e);
      }
    }),
  );

  const items: ActivityListRow[] = page.map((r) => {
    const entity = resolved.get(`${r.entityType}:${r.entityId}`);
    return {
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      occurredAt: r.occurredAt,
      actorId: r.actorId,
      actorSnapshot: r.actorSnapshot,
      title: entity?.title ?? titleFromData(r.data) ?? `#${r.entityId.slice(-6)}`,
      href: entity ? entityHref(r.entityType, { id: r.entityId, slug: entity.slug }) : null,
    };
  });

  return { items, nextCursor };
}

/**
 * Status-history events for a set of tasks, oldest first — the burndown's raw
 * material. Only the actions `computeBurndown` replays are fetched; the
 * row's `data` is narrowed to the status-bearing keys by the caller.
 */
export async function listTaskStatusEvents(taskIds: string[]) {
  if (taskIds.length === 0) return [];
  return db.activityLog.findMany({
    where: {
      entityType: "task",
      entityId: { in: taskIds },
      action: { in: ["TaskCreated", "TaskStatusChanged", "TaskMoved", "TaskDeleted"] },
    },
    select: { entityId: true, action: true, occurredAt: true, data: true },
    orderBy: { occurredAt: "asc" },
  });
}
