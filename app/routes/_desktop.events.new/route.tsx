import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { eventCreateSchema } from "~/domains/events/events.schema";
import { createEvent } from "~/domains/events/events.mutations.server";
import { ZodForm } from "~/components/forms";
import { EventFormFields } from "~/components/events/event-form-fields";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "events.meta.new") }];
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, eventCreateSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors };
  try {
    const event = await createEvent(actor, result.data);
    await emitChange({ entityType: "event", id: event.id, op: "created" });
    return redirect(`/events/${event.id}`);
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function NewEvent({ actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useT();
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">{t("events.new.title")}</h1>
        <Link to="/events" className="text-muted-foreground text-sm hover:underline">
          {t("events.back")}
        </Link>
      </div>
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <EventFormFields />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.creating") : t("events.new.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/events">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
