import { describe, expect, it } from "vitest";
import { NotificationType } from "~/generated/prisma/enums";
import { t, type MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { notificationLabelParams } from "../notification-list";

/**
 * Every notification type must render a label with NO literal placeholder left
 * in it, in both locales — the parity test only compares en↔de key sets, so a
 * params-shape mismatch (e.g. payload `dueAt` vs template `{date}`) is only
 * caught here.
 */
const PAYLOADS: Record<NotificationType, unknown> = {
  TASK_ASSIGNED: { title: "Beamer-Vergleich" },
  TASK_DUE_SOON: { title: "Beamer-Vergleich", dueAt: "2026-11-10T09:00:00.000Z" },
  BOOKING_CONFLICT: {
    roomId: "room-1",
    conflicts: [{ eventId: "ev-1", eventTitle: "GS Miete" }],
  },
  WARRANTY_EXPIRING: { name: "HDMI-Kabel 5m", warrantyExpiresAt: "2026-12-01T23:00:00.000Z" },
};

describe("notification type labels render fully in both locales", () => {
  for (const locale of ["en", "de"] as Locale[]) {
    for (const type of Object.values(NotificationType)) {
      it(`${locale} ${type}`, () => {
        const params = notificationLabelParams(type, PAYLOADS[type]);
        const label = t(locale, `notifications.type.${type}` as MessageKey, params);
        expect(label).not.toMatch(/[{}]/);
        expect(label.length).toBeGreaterThan(3);
      });
    }
  }

  it("due dates render as Berlin dates, not raw ISO instants", () => {
    const params = notificationLabelParams(NotificationType.TASK_DUE_SOON, PAYLOADS.TASK_DUE_SOON);
    expect(params.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.dueAt).toBeUndefined();
  });
});
