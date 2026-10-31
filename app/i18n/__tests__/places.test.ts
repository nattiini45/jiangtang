import { describe, expect, it } from "vitest";
import { categoryLabel, micKindLabel, mobilityLabel } from "~/components/inventory/labels";
import { kindLabel } from "~/components/locations/labels";
import { EquipmentCategory, EquipmentMobility, MicKind } from "~/generated/prisma/enums";
import { stockCreateSchema } from "~/domains/inventory/inventory.stock.schema";
import { messages, t } from "~/i18n";
import { LOCALES } from "~/i18n/locales";
import { STOCK_STATUS_ALIASES } from "~/lib/status";
import { safeParse } from "~/lib/validation.server";

describe("places catalogs", () => {
  it("keeps the German placeholders and uses generic English examples", () => {
    expect(t("de", "locations.form.namePlaceholder")).toBe("z. B. Hörsaal 1");
    expect(t("en", "locations.form.namePlaceholder")).toBe("e.g. Lecture hall 1");
    expect(t("de", "rooms.form.namePlaceholder")).toBe("z. B. Hörsaal 32");
    expect(t("en", "rooms.form.namePlaceholder")).toBe("e.g. Lecture hall 32");
  });

  it("interpolates quoted names the way the original German did", () => {
    expect(t("de", "rooms.clone.title", { name: "A" })).toBe('„A" duplizieren');
    expect(t("de", "inventory.detail.confirmRetire", { title: "B" })).toBe('„B" ausmustern?');
    expect(t("en", "locations.edit.confirmDelete", { name: "C" })).toBe("Delete “C”?");
  });

  it("labels every equipment enum value in both locales", () => {
    for (const locale of LOCALES) {
      for (const c of Object.values(EquipmentCategory)) {
        expect(categoryLabel(locale, c)).not.toContain("search.");
      }
      for (const m of Object.values(EquipmentMobility)) {
        expect(mobilityLabel(locale, m)).not.toContain("inventory.");
      }
      for (const k of Object.values(MicKind)) {
        expect(micKindLabel(locale, k)).not.toContain("inventory.");
      }
    }
    expect(categoryLabel("en", "MEDIA_CONTROL")).toBe("Media control");
    expect(mobilityLabel("en", "FIXED")).toBe("Fixed install");
    expect(micKindLabel("de", "BODYPACK")).toBe("Taschensender");
    expect(kindLabel("en", "STORAGE")).toBe("Storage");
  });

  it("lists the stock status labels of the request language in the validation error", () => {
    for (const locale of LOCALES) {
      const result = safeParse(stockCreateSchema, { name: "x", status: "nonsense" }, locale);
      expect(result.success).toBe(false);
      if (result.success) continue;
      const message = result.fieldErrors.status?.[0] ?? "";
      expect(message).toContain(STOCK_STATUS_ALIASES.labels(locale).join(" · "));
    }
  });

  it("has no German-only column help left in the English import descriptions", () => {
    const en = messages("en");
    expect(en["rooms.import.description"]).toMatch(/atomic/i);
    expect(en["inventory.import.description"]).toMatch(/atomic/i);
  });
});
