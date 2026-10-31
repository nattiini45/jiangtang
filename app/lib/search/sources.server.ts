/**
 * Source builders: each source type resolves to a
 * `{ title, sections, updatedAt }` document the indexer turns into Chunk rows.
 * `listSourceVersions` is the reconcile sweep's cheap "did it change" probe —
 * it must read only `id`/`updatedAt`.
 *
 * Meta lines and enum labels render in the workspace language (`DEFAULT_LOCALE`):
 * the index is queried in the language the installation works in. Ticket-type,
 * equipment-category and location-kind labels come from the catalog here rather
 * than `~/components/…/labels.ts` because `app/lib` must not depend on the
 * components layer; the status enums reuse `~/lib/status`.
 */
import { db } from "~/lib/db.server";
import {
  projectStatusLabel,
  stockStatusLabel,
  taskPriorityLabel,
  taskStatusLabel,
  statusLabel,
} from "~/lib/status";
import { formatDate, formatDateTime } from "~/i18n/format";
import { t as translate, type MessageKey } from "~/i18n";
import { workspaceLocale } from "~/i18n/locale.server";
import type { Locale } from "~/i18n/locales";
import { chunkMarkdown, type ChunkSection } from "./chunking";

// The vocabulary itself is client-safe — `source-types.ts` — and re-exported
// here so `indexer`/`index.boot`/`query`/`api.search` imports stay put.
export { SOURCE_TYPES, ENTITY_TO_SOURCE, SOURCE_TO_ENTITY } from "./source-types";
export type { SourceType } from "./source-types";
import type { SourceType } from "./source-types";

export interface SourceDoc {
  title: string;
  sections: ChunkSection[];
  updatedAt: Date;
}

export interface SourceVersion {
  id: string;
  updatedAt: Date;
}

/** One meta line as a bare section, then the body chunked as markdown. */
function doc(
  title: string,
  meta: string[],
  body: string | null | undefined,
  updatedAt: Date,
): SourceDoc {
  const metaText = meta.filter(Boolean).join(" · ");
  const sections: ChunkSection[] = [];
  if (metaText) sections.push({ headingPath: [], text: metaText });
  if (body?.trim()) sections.push(...chunkMarkdown(body));
  return { title, sections, updatedAt };
}

/** One `Label: value` meta entry; `null` when the value is empty so `doc()` drops it. */
function field(
  locale: Locale,
  key: MessageKey,
  value: string | number | null | undefined | false,
): string | null {
  if (value === null || value === undefined || value === false || value === "") return null;
  return `${translate(locale, key)}: ${value}`;
}

const initialsOf = (rows: { initials: string | null }[]) =>
  rows
    .map((a) => a.initials)
    .filter(Boolean)
    .join(", ");

const roomText = (r: { roomNumber: string | null; name: string }) =>
  [r.roomNumber, r.name].filter(Boolean).join(" ");

/** Walk the Location parent chain → "Site / Building / Room". */
async function locationPath(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const rows = await db.location.findMany({
    select: { id: true, name: true, code: true, parentId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parts: string[] = [];
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.code ? `${cur.name} (${cur.code})` : cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.length ? parts.join(" / ") : null;
}

export async function listSourceVersions(type: SourceType): Promise<SourceVersion[]> {
  switch (type) {
    case "TASK":
      return db.task.findMany({ select: { id: true, updatedAt: true } });
    case "TICKET":
      return db.ticket.findMany({ select: { id: true, updatedAt: true } });
    case "NOTE":
      return db.note.findMany({ select: { id: true, updatedAt: true } });
    case "PROJECT":
      return db.project.findMany({ select: { id: true, updatedAt: true } });
    case "INVENTORY_ITEM":
      return db.inventoryItem.findMany({ select: { id: true, updatedAt: true } });
    case "EQUIPMENT":
      return db.equipment.findMany({ select: { id: true, updatedAt: true } });
    case "EVENT":
      return db.event.findMany({ select: { id: true, updatedAt: true } });
    case "LOCATION":
      return db.location.findMany({ select: { id: true, updatedAt: true } });
    case "ROOM":
      return db.room.findMany({ select: { id: true, updatedAt: true } });
    case "VENDOR":
      return db.vendor.findMany({ select: { id: true, updatedAt: true } });
  }
}

export async function loadSource(type: SourceType, id: string): Promise<SourceDoc | null> {
  const locale = workspaceLocale();
  const f = (key: MessageKey, value: string | number | null | undefined | false) =>
    field(locale, key, value);
  const compact = (lines: (string | null)[]) => lines.filter(Boolean) as string[];

  switch (type) {
    case "TASK": {
      const task = await db.task.findUnique({
        where: { id },
        include: {
          project: { select: { name: true } },
          assignees: { include: { user: { select: { initials: true } } } },
        },
      });
      if (!task) return null;
      const meta = compact([
        f("search.meta.status", taskStatusLabel(locale, task.status)),
        f("search.meta.priority", task.priority && taskPriorityLabel(locale, task.priority)),
        f("search.meta.labels", task.labels.join(", ")),
        f("search.meta.project", task.project?.name),
        f("search.meta.assignees", initialsOf(task.assignees.map((a) => a.user))),
        f("search.meta.due", task.dueAt && formatDate(locale, task.dueAt)),
      ]);
      return doc(task.title, meta, task.body, task.updatedAt);
    }
    case "TICKET": {
      const ticket = await db.ticket.findUnique({
        where: { id },
        include: {
          room: { select: { name: true, roomNumber: true } },
          equipment: { include: { model: { select: { name: true, manufacturer: true } } } },
          assignees: { select: { initials: true } },
        },
      });
      if (!ticket) return null;
      const meta = compact([
        f("search.meta.type", translate(locale, `search.ticketType.${ticket.type}`)),
        f("search.meta.status", statusLabel(locale, "ticket", ticket.status)),
        f("search.meta.room", ticket.room && roomText(ticket.room)),
        f(
          "search.meta.equipment",
          ticket.equipment &&
            [
              ticket.equipment.model?.manufacturer,
              ticket.equipment.model?.name,
              ticket.equipment.name,
            ]
              .filter(Boolean)
              .join(" "),
        ),
        f("search.meta.assignees", initialsOf(ticket.assignees)),
        f("search.meta.priority", ticket.priority || null),
      ]);
      const body = [ticket.description, f("search.meta.resolution", ticket.resolution)]
        .filter(Boolean)
        .join("\n\n");
      return doc(ticket.title, meta, body, ticket.updatedAt);
    }
    case "NOTE": {
      const note = await db.note.findUnique({
        where: { id },
        include: { project: { select: { name: true } } },
      });
      if (!note) return null;
      const meta = compact([
        f("search.meta.tags", note.tags.join(", ")),
        f("search.meta.project", note.project?.name),
        note.archivedAt ? translate(locale, "search.meta.archived") : null,
      ]);
      return doc(note.title, meta, note.body, note.updatedAt);
    }
    case "PROJECT": {
      const project = await db.project.findUnique({
        where: { id },
        include: { lead: { select: { initials: true, name: true } } },
      });
      if (!project) return null;
      const meta = compact([
        f("search.meta.status", projectStatusLabel(locale, project.status)),
        f("search.meta.lead", project.lead && (project.lead.initials ?? project.lead.name)),
      ]);
      return doc(project.name, meta, project.description, project.updatedAt);
    }
    case "INVENTORY_ITEM": {
      const item = await db.inventoryItem.findUnique({
        where: { id },
        include: { vendor: { select: { name: true } } },
      });
      if (!item) return null;
      const path = await locationPath(item.locationId);
      const meta = compact([
        f("search.meta.sku", item.sku),
        f("search.meta.serial", item.serial),
        f("search.meta.category", item.category),
        f("search.meta.status", item.status && stockStatusLabel(locale, item.status)),
        f("search.meta.stock", `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`),
        f("search.meta.tags", item.tags.join(", ")),
        f("search.meta.location", path),
        f("search.meta.vendor", item.vendor?.name),
      ]);
      return doc(item.name, meta, null, item.updatedAt);
    }
    case "EQUIPMENT": {
      const eq = await db.equipment.findUnique({
        where: { id },
        include: {
          model: { select: { name: true, manufacturer: true } },
          room: { select: { name: true, roomNumber: true } },
        },
      });
      if (!eq) return null;
      const meta = compact([
        f("search.meta.category", translate(locale, `search.equipmentCategory.${eq.category}`)),
        f("search.meta.status", statusLabel(locale, "equipment", eq.status)),
        f("search.meta.serial", eq.serial),
        f("search.meta.assetTag", eq.assetTag),
        f("search.meta.ip", eq.ipAddress),
        f("search.meta.mac", eq.macAddress),
        f("search.meta.hostname", eq.hostname),
        f("search.meta.room", eq.room && roomText(eq.room)),
      ]);
      return doc(
        [eq.model?.manufacturer, eq.model?.name, eq.name].filter(Boolean).join(" ") || eq.id,
        meta,
        null,
        eq.updatedAt,
      );
    }
    case "EVENT": {
      const ev = await db.event.findUnique({
        where: { id },
        include: { rooms: { include: { room: { select: { name: true, roomNumber: true } } } } },
      });
      if (!ev) return null;
      const meta = compact([
        f("search.meta.status", statusLabel(locale, "event", ev.status)),
        f(
          "search.meta.time",
          `${formatDateTime(locale, ev.startsAt)} – ${formatDateTime(locale, ev.endsAt)}`,
        ),
        f("search.meta.rooms", ev.rooms.map((r) => roomText(r.room)).join(", ")),
        f("search.meta.organizer", ev.organizer),
      ]);
      return doc(ev.title, meta, ev.description, ev.updatedAt);
    }
    case "LOCATION": {
      const loc = await db.location.findUnique({ where: { id } });
      if (!loc) return null;
      const path = await locationPath(loc.id);
      const meta = compact([
        f("search.meta.type", translate(locale, `locations.kind.${loc.kind}`)),
        f("search.meta.code", loc.code),
        f("search.meta.address", loc.address),
        f("search.meta.path", path),
      ]);
      return doc(loc.name, meta, loc.description, loc.updatedAt);
    }
    case "ROOM": {
      const room = await db.room.findUnique({
        where: { id },
        include: { building: { select: { name: true } } },
      });
      if (!room) return null;
      const meta = compact([
        f("search.meta.roomNumber", room.roomNumber),
        f("search.meta.building", room.building?.name),
        f("search.meta.status", statusLabel(locale, "room", room.status)),
      ]);
      return doc(roomText(room) || room.name, meta, null, room.updatedAt);
    }
    case "VENDOR": {
      const v = await db.vendor.findUnique({ where: { id } });
      if (!v) return null;
      const meta = compact([
        f("search.meta.contact", v.contact),
        f("search.meta.email", v.email),
        f("search.meta.phone", v.phone),
        f("search.meta.web", v.url),
        f("search.meta.address", v.address),
      ]);
      return doc(v.name, meta, null, v.updatedAt);
    }
  }
}
