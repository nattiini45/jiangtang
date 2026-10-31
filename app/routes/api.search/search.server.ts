import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { listTickets } from "~/domains/tickets/tickets.queries.server";
import { listEvents } from "~/domains/events/events.queries.server";
import { listEquipment } from "~/domains/inventory/inventory.queries.server";
import {
  findStockItemBySku,
  findStockItemBySerial,
} from "~/domains/inventory/inventory.stock.queries.server";
import { hybridSearch } from "~/lib/search/query.server";
import { SOURCE_TO_ENTITY } from "~/lib/search/sources.server";
import { searchAnchor, sourceTypeLabel } from "~/lib/search/labels";
import { workspaceLocale } from "~/i18n/locale.server";
import type { Locale } from "~/i18n/locales";

/**
 * Search body backing the global command palette (Ctrl/Cmd-K). Lives in a
 * `.server` module (not the route file): route modules may only export
 * loader/action-family names once they touch server code — any extra export
 * (like this helper) would be pulled into the client bundle and fail the
 * build. Factored out of the loader so it is also unit-testable without a
 * Better Auth session.
 */

export type SearchResultType =
  | "room"
  | "ticket"
  | "event"
  | "equipment"
  | "inventory-item"
  | "task"
  | "note"
  | "project"
  | "location"
  | "vendor";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
}

const PER_TYPE = 6;
const MIN_LEN = 2;
const MAX_LEN = 100;

/** Bounded cross-entity search. Returns [] for a too-short/too-long query. */
export async function runSearch(
  raw: string,
  locale: Locale = workspaceLocale(),
): Promise<SearchResult[]> {
  const q = raw.trim();
  if (q.length < MIN_LEN || q.length > MAX_LEN) return [];

  const [rooms, tickets, events, equipment, bySerial, bySku] = await Promise.all([
    listRooms({ q }),
    listTickets({ q }),
    listEvents({ q }),
    listEquipment({ q }),
    findStockItemBySerial(q),
    findStockItemBySku(q),
  ]);

  const results: SearchResult[] = [];

  for (const r of rooms.slice(0, PER_TYPE)) {
    results.push({
      type: "room",
      id: r.id,
      label: r.name,
      sublabel: r.roomNumber ?? r.buildingName ?? r.campusName,
      href: `/rooms/${r.slug}`,
    });
  }
  for (const t of tickets.slice(0, PER_TYPE)) {
    results.push({
      type: "ticket",
      id: t.id,
      label: t.title,
      sublabel: t.roomName ?? t.equipmentName,
      href: `/tickets/${t.id}`,
    });
  }
  for (const e of events.slice(0, PER_TYPE)) {
    results.push({
      type: "event",
      id: e.id,
      label: e.title,
      sublabel: e.organizer,
      href: `/events/${e.id}`,
    });
  }
  for (const g of equipment.slice(0, PER_TYPE)) {
    results.push({
      type: "equipment",
      id: g.id,
      label: g.name ?? g.modelName ?? g.category,
      sublabel: g.assetTag ?? g.roomName,
      href: `/inventory/${g.id}`,
    });
  }

  // The identifier arm, and it is the arm the product requirement is named
  // after ("found by serial through the existing search route").
  //
  // ⚠️ **Two `findUnique` calls, not a `contains` filter —
  // and the difference is the whole feature.** `serial` and `sku` are `@@unique`
  // (the schema's unique indexes), so an equality lookup can use that index and returns at
  // most one row each. A `contains` would instead return the item whose serial
  // happens to be a *substring* of the query — a serial is an identifier, and a
  // prefix of one is a different, usually non-existent device, so a substring
  // match hands the technician the wrong box. Two items can also both match (one
  // by serial, one by sku), hence the id set: a row whose serial and sku are the
  // same string is still one result, and the palette keys on `type:id`.
  //
  // **Case-sensitive, deliberately.** Exact means the column's own equality, and
  // Postgres' unique index is case-sensitive: an `insensitive` match cannot use
  // it, which would make "exact" a second, differently-shaped lookup. Logged as
  // the corpus nowhere says which reading the palette wants.
  //
  // ⚠️ **No name arm here, and that is scope, not an oversight.** `listStock`
  // already does `contains` on the name and the stock page owns it; the palette's
  // job for this family is the identifier, which the page's search box cannot do
  // (a serial is not in the name).
  const seenStock = new Set<string>();
  for (const item of [bySerial, bySku]) {
    if (!item || seenStock.has(item.id)) continue;
    seenStock.add(item.id);
    results.push({
      type: "inventory-item",
      id: item.id,
      label: item.name,
      // Where the thing is — the first question after "which box is it".
      sublabel: item.location?.name ?? null,
      href: `/inventory/stock/${item.id}`,
    });
  }

  // The index arm: every chunk-backed source type (tasks, notes,
  // projects, locations, vendors, and again the families above) through
  // `hybridSearch`. Appended behind the classic arms and deduped on type:id —
  // a row the title arm already found must not come back as a second option.
  // Hits without a page (unknown source type, missing slug) are dropped: the
  // palette can only navigate.
  try {
    const seen = new Set(results.map((r) => `${r.type}:${r.id}`));
    const { results: hits } = await hybridSearch(q, { limit: 10 });
    for (const h of hits) {
      const entity = SOURCE_TO_ENTITY[h.sourceType as keyof typeof SOURCE_TO_ENTITY] as
        | SearchResultType
        | undefined;
      if (!entity || !h.href || seen.has(`${entity}:${h.sourceId}`)) continue;
      seen.add(`${entity}:${h.sourceId}`);
      results.push({
        type: entity,
        id: h.sourceId,
        label: h.title,
        sublabel: `${sourceTypeLabel(locale, h.sourceType)} · ${searchAnchor(h.sourceType, h.sourceId, h.ordinal)}`,
        href: h.href,
      });
    }
  } catch {
    // The palette degrades to its classic arms — a broken index must not take
    // Ctrl-K down with it. The /search page surfaces `degraded` instead.
  }

  return results;
}
