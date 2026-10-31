/**
 * The index source-type vocabulary — client-safe: the `/search` page's
 * type chips and the eval live in the same bundle as this list. Server code
 * (`sources.server.ts`) re-exports it so existing imports keep working.
 */
import type { EntityType } from "~/lib/realtime/events";

export const SOURCE_TYPES = [
  "TASK",
  "TICKET",
  "NOTE",
  "PROJECT",
  "INVENTORY_ITEM",
  "EQUIPMENT",
  "EVENT",
  "LOCATION",
  "ROOM",
  "VENDOR",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** Realtime entity vocabulary → index source type (index.boot.server.ts). */
export const ENTITY_TO_SOURCE: Partial<Record<EntityType, SourceType>> = {
  task: "TASK",
  ticket: "TICKET",
  note: "NOTE",
  project: "PROJECT",
  "inventory-item": "INVENTORY_ITEM",
  equipment: "EQUIPMENT",
  event: "EVENT",
  location: "LOCATION",
  room: "ROOM",
  vendor: "VENDOR",
};

/** The reverse — index source type → entity vocabulary (query.api.search). */
export const SOURCE_TO_ENTITY: Record<SourceType, EntityType> = Object.fromEntries(
  Object.entries(ENTITY_TO_SOURCE).map(([entity, source]) => [source, entity]),
) as Record<SourceType, EntityType>;
