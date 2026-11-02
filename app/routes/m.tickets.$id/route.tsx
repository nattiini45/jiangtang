import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { tr } from "~/i18n/request-locale.server";
import { resolveLocale } from "~/i18n/locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { getTicket } from "~/domains/tickets/tickets.queries.server";
import { listAttachments } from "~/domains/attachments/attachments.queries.server";
import { ticketTransitionSchema } from "~/domains/tickets/tickets.schema";
import { transitionTicket } from "~/domains/tickets/tickets.mutations.server";
import { berlinDateInput } from "~/lib/format-date";
import { ticketTypeLabel } from "~/components/tickets/labels";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import { StatusBadge } from "~/components/ui/status-badge";
import { Button } from "~/components/ui/button";

/**
 * Mobile ticket detail + close. Read-only projection of the
 * desktop detail (title, links, description, resolution, timestamps, photos) plus
 * the SAME guarded status transitions — the action mirrors the desktop action
 * exactly (ticketTransitionSchema → transitionTicket → emitChange) so audit + SSE
 * behave identically across surfaces. Legal moves are rendered as large tap targets.
 */
export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  const title = data?.ticket.title ?? translate(locale, "tickets.meta.fallbackTitle");
  return [{ title: translate(locale, "tickets.meta.detail", { title }) }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const ticket = await getTicket(params.id);
  if (!ticket) throw toErrorResponse(new NotFoundError(tr("err.ticket.notFound")));
  const attachments = await listAttachments({ ticketId: params.id });
  return { ticket, attachments };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const id = params.id;
  const form = await request.formData();
  try {
    const result = safeParse(
      ticketTransitionSchema,
      formDataToObject(form),
      resolveLocale(request),
    );
    if (!result.success) return { fieldErrors: result.fieldErrors };
    const ticket = await transitionTicket(actor, id, result.data);
    // Mirror the desktop action: post-commit emitChange so SSE clients refetch.
    await emitChange({ entityType: "ticket", id: ticket.id, op: "updated" });
    return redirect(`/m/tickets/${id}`);
  } catch (e) {
    if (e instanceof ValidationError) {
      // The transition form renders no `status` field, so a field-keyed error is
      // invisible — surface it as a general form error too (mirrors desktop).
      return { fieldErrors: e.fieldErrors, formError: e.formErrors[0] };
    }
    throw toErrorResponse(e);
  }
}

export default function MobileTicketDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { ticket, attachments } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const locale = useLocale();
  const t = useT();
  const openish = ticket.status === "OPEN" || ticket.status === "IN_PROGRESS";

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground font-mono text-xs uppercase">
            {ticketTypeLabel(locale, ticket.type)}
          </span>
          <StatusBadge kind="ticket" value={ticket.status} />
        </div>
        <h1 className="mt-1 font-mono text-lg">{ticket.title}</h1>
      </div>

      {/* Linked context */}
      <div className="text-muted-foreground flex flex-col gap-1 text-sm">
        {ticket.room ? (
          <span>
            {t("tickets.detail.room")}{" "}
            <Link to={`/m/rooms/${ticket.room.slug}`} className="text-foreground hover:underline">
              {ticket.room.name}
            </Link>
          </span>
        ) : null}
        {ticket.reporter ? (
          <span>
            {t("tickets.detail.reportedBy")} {ticket.reporter.initials ?? ticket.reporter.name}
          </span>
        ) : null}
        <span className="font-mono text-xs">
          {t("mobile.tickets.captured", { date: berlinDateInput(ticket.occurredAt) })}
          {ticket.resolvedAt
            ? t("mobile.tickets.resolvedAt", { date: berlinDateInput(ticket.resolvedAt) })
            : ""}
        </span>
      </div>

      {ticket.description ? (
        <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
      ) : null}

      {ticket.status === "RESOLVED" && ticket.resolution ? (
        <section className="border-status-operational/40 bg-status-operational/10 border p-3">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {t("tickets.detail.resolution")}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{ticket.resolution}</p>
        </section>
      ) : null}

      {/* Attachments (read-only thumbnails). */}
      {attachments.length > 0 ? (
        <section className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {t("tickets.detail.photos")}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {attachments.map((a) => (
              <a
                key={a.id}
                href={`/attachments/${a.objectKey}`}
                target="_blank"
                rel="noreferrer"
                className="border-border block overflow-hidden border"
              >
                <img
                  src={`/attachments/${a.objectKey}?thumb=1`}
                  alt={a.filename}
                  loading="lazy"
                  className="bg-muted aspect-square w-full object-cover"
                />
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {/* Workflow transitions — large touch buttons for the legal moves. */}
      <section className="border-border flex flex-col gap-3 border p-3">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          {t("tickets.detail.changeStatus")}
        </p>
        {actionData && "formError" in actionData && actionData.formError ? (
          <p className="text-destructive text-sm" role="alert">
            {actionData.formError}
          </p>
        ) : null}

        {ticket.status === "OPEN" ? (
          <TransitionButton
            status="IN_PROGRESS"
            label={t("tickets.detail.takeInProgress")}
            busy={busy}
          />
        ) : null}
        {ticket.status === "RESOLVED" || ticket.status === "CANCELLED" ? (
          <TransitionButton
            status="OPEN"
            label={t("tickets.detail.reopen")}
            variant="outline"
            busy={busy}
          />
        ) : null}
        {ticket.status === "OPEN" || ticket.status === "IN_PROGRESS" ? (
          <TransitionButton
            status="CANCELLED"
            label={t("common.cancel")}
            variant="outline"
            busy={busy}
          />
        ) : null}

        {openish ? (
          <Form method="post" className="border-border flex flex-col gap-2 border-t pt-3">
            <input type="hidden" name="status" value="RESOLVED" />
            <label className="text-sm font-medium" htmlFor="resolution">
              {t("tickets.detail.markResolved")}
            </label>
            <textarea
              id="resolution"
              name="resolution"
              rows={2}
              placeholder={t("tickets.detail.resolutionPlaceholder")}
              className="border-input bg-background rounded-sm border px-3 py-2 text-base"
            />
            {actionData?.fieldErrors?.resolution ? (
              <p className="text-destructive text-xs" role="alert">
                {actionData.fieldErrors.resolution[0]}
              </p>
            ) : null}
            <Button type="submit" disabled={busy} className="h-12 text-base">
              {t("tickets.detail.resolve")}
            </Button>
          </Form>
        ) : null}
      </section>

      <Link to="/m/tickets" className="text-muted-foreground text-center text-sm underline">
        {t("mobile.tickets.backAll")}
      </Link>
    </div>
  );
}

function TransitionButton({
  status,
  label,
  variant,
  busy,
}: {
  status: string;
  label: string;
  variant?: "outline";
  busy: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="status" value={status} />
      <Button type="submit" variant={variant} disabled={busy} className="h-12 w-full text-base">
        {label}
      </Button>
    </Form>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
