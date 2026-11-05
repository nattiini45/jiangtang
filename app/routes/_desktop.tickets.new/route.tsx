import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { parseEnumParam, safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { listTicketTargets } from "~/domains/tickets/tickets.queries.server";
import { ticketCreateSchema } from "~/domains/tickets/tickets.schema";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";
import { TicketType } from "~/generated/prisma/enums";
import { ZodForm } from "~/components/forms";
import { TicketFormFields, type TicketDefaults } from "~/components/tickets/ticket-form-fields";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "tickets.meta.new") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const typeParam = url.searchParams.get("type") || "";
  const targets = await listTicketTargets();
  const defaults: TicketDefaults = {
    roomId: url.searchParams.get("roomId"),
    equipmentId: url.searchParams.get("equipmentId"),
    eventId: url.searchParams.get("eventId"),
    type: parseEnumParam(TicketType, typeParam) ?? null,
  };
  return { ...targets, defaults };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, ticketCreateSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors };
  try {
    const ticket = await createTicket(actor, result.data);
    await emitChange({ entityType: "ticket", id: ticket.id, op: "created" });
    return redirect(`/tickets/${ticket.id}`);
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function NewTicket({ loaderData, actionData }: Route.ComponentProps) {
  const { rooms, equipment, users, defaults } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useT();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("tickets.new.title")}</h1>
        <Link to="/tickets" className="text-muted-foreground text-sm hover:underline">
          {t("tickets.back")}
        </Link>
      </div>
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors}>
        <TicketFormFields
          mode="create"
          rooms={rooms}
          equipment={equipment}
          users={users}
          defaults={defaults}
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.creating") : t("tickets.new.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/tickets">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
