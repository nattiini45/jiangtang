import { recordReading, invalidReading } from "./readings.mutations.server";
import { readingDevices } from "./readings.queries.server";
import { berlinLocalToUtc, utcToBerlinLocal } from "~/lib/time.server";
import type { AuditActor } from "~/lib/audit.server";
import { ValidationError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { takePartForDevice } from "~/domains/inventory/inventory.parts.mutations.server";

export async function readingFromForm(
  form: FormData,
  actor: AuditActor,
  equipmentId: string,
  roundId?: string,
) {
  try {
    if (form.get("intent") === "replacePart") {
      await takePartForDevice(actor, equipmentId, String(form.get("stockId") ?? ""), true);
      return { readingSaved: true };
    }
    const device = (await readingDevices({ id: equipmentId }))[0];
    const fieldId = String(form.get("fieldId") ?? "");
    const measure = device?.measures.find((field) => field.id === fieldId);
    const raw = String(form.get("value") ?? "").trim();
    if (!measure || !raw) throw invalidReading();
    const value =
      measure.type === "NUMBER"
        ? Number(raw)
        : measure.type === "BOOLEAN"
          ? raw === "true"
            ? true
            : raw === "false"
              ? false
              : null
          : raw;
    const date = String(form.get("observedAt") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(date))
      throw invalidReading();
    const normalized =
      date.length === 16
        ? `${date}:00.000`
        : date.length === 19
          ? `${date}.000`
          : date.padEnd(23, "0");
    if (Number.isNaN(new Date(`${normalized}Z`).getTime())) throw invalidReading();
    const observedAt = berlinLocalToUtc(date);
    if (utcToBerlinLocal(observedAt, "millisecond") !== normalized) throw invalidReading();
    await recordReading(actor, { equipmentId, fieldId, value, observedAt, roundId });
    return { readingSaved: true };
  } catch (error) {
    if (error instanceof ValidationError)
      return {
        readingError:
          form.get("intent") === "replacePart"
            ? (error.formErrors[0] ?? tr("readings.invalid"))
            : tr("readings.invalid"),
      };
    throw toErrorResponse(error);
  }
}
