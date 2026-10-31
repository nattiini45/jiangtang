import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { EventStatus } from "~/generated/prisma/enums";
import { useLocale, useT } from "~/i18n/use-t";
import { eventStatusLabel } from "./labels";

export interface EventDefaults {
  title?: string | null;
  description?: string | null;
  startsAt?: string; // YYYY-MM-DDTHH:mm (Berlin wall-clock)
  endsAt?: string;
  status?: EventStatus | null;
  organizer?: string | null;
  contact?: string | null;
}

export function EventFormFields({ defaults = {} }: { defaults?: EventDefaults }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-4">
      <FormField name="title" label={t("events.form.title")}>
        <Input
          name="title"
          defaultValue={defaults.title ?? ""}
          placeholder={t("events.form.titlePlaceholder")}
          autoFocus
        />
      </FormField>

      <FormField
        name="description"
        label={t("events.form.description")}
        hint={t("common.optional")}
      >
        <Textarea name="description" defaultValue={defaults.description ?? ""} rows={3} />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="startsAt" label={t("events.form.startsAt")} hint="Europe/Berlin">
          <Input type="datetime-local" name="startsAt" defaultValue={defaults.startsAt ?? ""} />
        </FormField>
        <FormField name="endsAt" label={t("events.form.endsAt")} hint="Europe/Berlin">
          <Input type="datetime-local" name="endsAt" defaultValue={defaults.endsAt ?? ""} />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <FormField name="status" label={t("events.form.status")}>
          {/* CANCELLED is reached via the dedicated „Absagen" action (which frees
              slots), not picked here. */}
          <Select name="status" defaultValue={defaults.status ?? EventStatus.PLANNED}>
            {Object.values(EventStatus)
              .filter((s) => s !== EventStatus.CANCELLED)
              .map((s) => (
                <option key={s} value={s}>
                  {eventStatusLabel(locale, s)}
                </option>
              ))}
          </Select>
        </FormField>
        <FormField name="organizer" label={t("events.form.organizer")} hint={t("common.optional")}>
          <Input name="organizer" defaultValue={defaults.organizer ?? ""} />
        </FormField>
      </div>

      <FormField
        name="contact"
        label={t("events.form.contact")}
        hint={t("events.form.contactHint")}
      >
        <Input name="contact" defaultValue={defaults.contact ?? ""} />
      </FormField>
    </div>
  );
}
