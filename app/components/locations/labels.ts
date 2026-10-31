import { LocationKind } from "~/generated/prisma/enums";
import { t, type MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";

/**
 * The 8 `LocationKind` values rendered in prose, plus the badge tint each
 * one wears in the tree.
 *
 * Labels come from the i18n catalog (`locations.kind.*`); the typed template key
 * is a compile error the moment an enum value is added without a catalog entry.
 *
 * The badge tints stay inside the **existing** token set (`app/app.css` defines
 * `primary` and `destructive` and nothing else — there is no `warning`), because
 * Tailwind v4 silently generates *nothing* for a theme key that does not exist:
 * a `border-warning` class is a no-op that reads as a design decision in review
 * and paints nothing in the browser. A `ROOM` is what a technician actually
 * stands in front of, so it alone carries the `primary` emphasis; a `VIRTUAL`
 * location is a place that is not a place, and is drawn dashed.
 */
export const LOCATION_KIND_BADGE_CLASS: Record<LocationKind, string> = {
  SITE: "border-border",
  BUILDING: "border-border",
  ROOM: "border-primary text-primary",
  STORAGE: "border-border",
  RACK: "border-border",
  VEHICLE: "border-border",
  EXTERNAL: "border-border text-muted-foreground",
  VIRTUAL: "border-dashed text-muted-foreground",
};

/** Every kind in enum order — the filter bar and both `<Select>`s render this. */
export const LOCATION_KINDS: LocationKind[] = Object.values(LocationKind);

const _everyKindHasLabel: `locations.kind.${LocationKind}` extends MessageKey ? true : never = true;

/** Prose label, with a total function: an unknown kind must not blank the cell. */
export function kindLabel(locale: Locale, kind: string): string {
  const key = `locations.kind.${kind}` as MessageKey;
  const label = t(locale, key);
  return label === key ? kind : label;
}
