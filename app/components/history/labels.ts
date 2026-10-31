import { t, type MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import type { EntityType } from "~/lib/realtime/events";

// Fails `tsc` when an `EntityType` has no catalog entry.
const _everyEntityHasLabel: `history.entity.${EntityType}` extends MessageKey ? true : never = true;

/**
 * The verb an audit `action` renders as in the activity feed. An action nobody
 * labelled shows as its raw name rather than a blank row; the guard test in
 * `__tests__/action-labels.test.ts` keeps that from shipping.
 */
export function actionLabel(locale: Locale, action: string): string {
  const key = `history.action.${action}` as MessageKey;
  const label = t(locale, key);
  return label === key ? action : label;
}

/** Label for an activity-feed entity type (every `ENTITY_TYPES` member has one);
 *  an unknown wire value renders as itself rather than a blank chip. */
export function entityTypeLabel(locale: Locale, type: EntityType | string): string {
  const key = `history.entity.${type}` as MessageKey;
  const label = t(locale, key);
  return label === key ? type : label;
}
