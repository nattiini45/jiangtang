import type { EntityType } from "~/lib/realtime/events";

/**
 * Entity → deep link. Client-safe: `/activity` renders these hrefs and
 * the search results reuse them.
 *
 * `ref` carries what the route needs — most pages key on `id`, but `/rooms`
 * and `/projects` are slug-routed, so the caller passes `slug` when it has it.
 * `entityType` is typed `EntityType | string` on purpose: the ActivityLog
 * column is a reader-side `string` (26 legacy spellings exist) — a
 * legacy or unknown type simply yields `null` instead of a compile error.
 * `null` is also the honest answer for entities that have no detail page at
 * all (campus, building, the booking sub-rows, attachment keys…).
 */
export interface EntityRef {
  id: string;
  slug?: string | null;
}

export function entityHref(entityType: EntityType | string, ref: EntityRef): string | null {
  switch (entityType) {
    case "task":
      return `/tasks/${ref.id}`;
    case "ticket":
      return `/tickets/${ref.id}`;
    case "project":
      return ref.slug ? `/projects/${ref.slug}` : null;
    case "note":
      return `/notes/${ref.id}`;
    case "location":
      return `/locations/${ref.id}`;
    case "inventory-item":
      return `/inventory/stock/${ref.id}`;
    case "equipment":
      return `/inventory/${ref.id}`;
    case "equipmentModel":
      return `/inventory/models/${ref.id}`;
    case "event":
      return `/events/${ref.id}`;
    case "room":
      return ref.slug ? `/rooms/${ref.slug}` : null;
    case "user":
      return `/admin/users/${ref.id}`;
    default:
      return null;
  }
}
