import { useId } from "react";
import { FormField, useFieldError } from "~/components/forms";
import { Checkbox } from "~/components/ui/checkbox";
import { Textarea } from "~/components/ui/textarea";
import { useT } from "~/i18n/use-t";
import type { HealthBookingAction } from "~/domains/events/events.health-policy";

export function HealthOverrideFields({
  action,
  entity,
}: {
  action: HealthBookingAction;
  entity: "room" | "equipment";
}) {
  const t = useT();
  const id = useId();
  const error = useFieldError("healthOverrideConfirmed");
  const reasonError = useFieldError("healthOverrideReason");
  if (!action.requiresConfirmation && !error && !reasonError) return null;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-2 text-sm font-semibold">{t("events.health.title")}</legend>
      <p id={`${id}-hint`} className="text-muted-foreground text-sm">
        {t(entity === "room" ? "events.health.roomWarning" : "events.health.equipmentWarning")}
      </p>
      <FormField name="healthOverrideReason" label={t("events.health.reason")}>
        <Textarea
          id={`${id}-reason`}
          name="healthOverrideReason"
          required
          aria-describedby={`${id}-hint`}
          aria-invalid={Boolean(reasonError)}
        />
      </FormField>
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
        <Checkbox
          name="healthOverrideConfirmed"
          value="true"
          required
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          aria-invalid={Boolean(error)}
        />
        <span>{t("events.health.confirm")}</span>
      </label>
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
