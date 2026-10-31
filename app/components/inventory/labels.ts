import type { EquipmentCategory, EquipmentMobility, MicKind } from "~/generated/prisma/client";
import { t, type MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";

// The label function lives in `~/lib/status` — the domain schema consumes it, and a
// domain must not import the components layer. Re-exported so UI imports don't churn.
export { stockStatusLabel } from "~/lib/status";

/** Localized labels for the equipment enums (client-safe; reused across inventory views). */

export function categoryLabel(locale: Locale, category: EquipmentCategory): string {
  return t(locale, `search.equipmentCategory.${category}`);
}

export function mobilityLabel(locale: Locale, mobility: EquipmentMobility): string {
  return t(locale, `inventory.mobility.${mobility}`);
}

export function micKindLabel(locale: Locale, kind: MicKind): string {
  return t(locale, `inventory.micKind.${kind}`);
}

const _everyCategoryHasLabel: `search.equipmentCategory.${EquipmentCategory}` extends MessageKey
  ? true
  : never = true;
const _everyMobilityHasLabel: `inventory.mobility.${EquipmentMobility}` extends MessageKey
  ? true
  : never = true;
const _everyMicKindHasLabel: `inventory.micKind.${MicKind}` extends MessageKey ? true : never =
  true;
