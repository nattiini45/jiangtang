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
import { QuickEntryForm } from "~/components/tickets/quick-entry-form";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "quickEntry.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const typeParam = url.searchParams.get("type") || "";
  const targets = await listTicketTargets();
  return {
    rooms: targets.rooms,
    equipment: targets.equipment,
    defaults: {
      roomId: url.searchParams.get("roomId"),
      equipmentId: url.searchParams.get("equipmentId"),
      type: parseEnumParam(TicketType, typeParam) ?? null,
    },
  };
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

export default function QuickEntry({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { rooms, equipment, defaults } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("tickets.list.quickEntry")}</h1>
          <p className="text-muted-foreground mt-1">{t("quickEntry.subtitle")}</p>
        </div>
        <Link to="/tickets" className="text-muted-foreground text-sm hover:underline">
          {t("tickets.back")}
        </Link>
      </div>
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors}>
        <QuickEntryForm rooms={rooms} equipment={equipment} defaults={defaults} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("quickEntry.submitting") : t("quickEntry.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/tickets">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
