import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import {
  getTicket,
  listTicketTargets,
  type AssignableUser,
} from "~/domains/tickets/tickets.queries.server";
import { listEntityHistory } from "~/domains/tickets/tickets.history.server";
import { raiseTaskFromTicket } from "~/domains/tasks/tasks.harmony.server";
import { listProjectOptions } from "~/domains/projects/projects.queries.server";
import { listAttachments } from "~/domains/attachments/attachments.queries.server";
import { ticketEditSchema, ticketTransitionSchema } from "~/domains/tickets/tickets.schema";
import { transitionTicket, updateTicket } from "~/domains/tickets/tickets.mutations.server";
import { berlinDateInput } from "~/lib/format-date";
import { ZodForm } from "~/components/forms";
import { TicketFormFields, type TicketDefaults } from "~/components/tickets/ticket-form-fields";
import { ticketTypeLabel } from "~/components/tickets/labels";
import { ActivityFeed } from "~/components/history/activity-feed";
import { FileUpload } from "~/components/upload/file-upload";
import { AttachmentGallery } from "~/components/upload/attachment-gallery";
import { AttachmentCategory } from "~/generated/prisma/enums";
import { StatusBadge } from "~/components/ui/status-badge";
import { Button } from "~/components/ui/button";
import { Card, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "tickets.meta.detail", {
        title: data?.ticket.title ?? t(locale, "tickets.meta.fallbackTitle"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const locale = resolveLocale(request);
  const ticket = await getTicket(params.id);
  if (!ticket) throw toErrorResponse(new NotFoundError(t(locale, "err.ticket.notFound")));
  const [targets, history, attachments, projects] = await Promise.all([
    listTicketTargets(),
    listEntityHistory("ticket", params.id),
    listAttachments({ ticketId: params.id }),
    listProjectOptions(),
  ]);
  // The picker lists only active users; merge in this ticket's currently-linked
  // reporter/assignees (who may have since been deactivated) so an edit doesn't
  // silently drop them.
  const byId = new Map<string, AssignableUser>(targets.users.map((u) => [u.id, u]));
  for (const u of [ticket.reporter, ...ticket.assignees]) {
    if (u && !byId.has(u.id)) byId.set(u.id, { id: u.id, name: u.name, initials: u.initials });
  }
  const users = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
  return {
    ticket,
    rooms: targets.rooms,
    equipment: targets.equipment,
    users,
    history,
    attachments,
    projects,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "update");
  const id = params.id;
  try {
    if (intent === "transition") {
      const result = safeParse(ticketTransitionSchema, formDataToObject(form), locale);
      if (!result.success) return { fieldErrors: result.fieldErrors };
      const ticket = await transitionTicket(actor, id, result.data);
      await emitChange({ entityType: "ticket", id: ticket.id, op: "updated" });
      return redirect(`/tickets/${id}`);
    }
    if (intent === "raise-task") {
      // an OPEN ticket becomes planned work — a TODO task is created with
      // title/body/assignees/priority from the ticket and BOTH link columns are
      // set in one transaction. The optional `projectId` preselect files the
      // new task under a project; `""` means none.
      const projectId = String(form.get("projectId") ?? "") || undefined;
      const { task } = await raiseTaskFromTicket(actor, id, { projectId });
      await emitChange({ entityType: "task", id: task.id, op: "created" });
      await emitChange({ entityType: "ticket", id, op: "updated" });
      return redirect(`/tasks/${task.id}`);
    }
    const result = safeParse(ticketEditSchema, formDataToObject(form), locale);
    if (!result.success) return { fieldErrors: result.fieldErrors };
    const ticket = await updateTicket(actor, id, result.data);
    await emitChange({ entityType: "ticket", id: ticket.id, op: "updated" });
    return redirect(`/tickets/${id}`);
  } catch (e) {
    if (e instanceof ValidationError) {
      // An illegal transition is keyed to `status`, a field the transition form
      // doesn't render — surface it as a general form error too so it's visible
      // instead of a silent no-op.
      return { fieldErrors: e.fieldErrors, formError: e.formErrors[0] };
    }
    throw toErrorResponse(e);
  }
}

export default function TicketDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { ticket, rooms, equipment, users, history, attachments, projects } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useT();
  const locale = useLocale();

  const defaults: TicketDefaults = {
    type: ticket.type,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    roomId: ticket.roomId,
    equipmentId: ticket.equipmentId,
    eventId: ticket.eventId,
    reporterId: ticket.reporterId,
    assigneeIds: ticket.assignees.map((a) => a.id),
    occurredAt: berlinDateInput(ticket.occurredAt),
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">
            {ticketTypeLabel(locale, ticket.type)}
          </span>
          <h1 className="text-xl font-bold">{ticket.title}</h1>
          <StatusBadge kind="ticket" value={ticket.status} />
        </div>
        <Link to="/tickets" className="text-muted-foreground text-sm hover:underline">
          {t("tickets.back")}
        </Link>
      </div>

      {/* Linked context */}
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {ticket.room ? (
          <span>
            {t("tickets.detail.room")}{" "}
            <Link to={`/rooms/${ticket.room.slug}`} className="text-foreground hover:underline">
              {ticket.room.name}
            </Link>
          </span>
        ) : null}
        {ticket.equipment ? (
          <span>
            {t("tickets.detail.equipment")}{" "}
            <Link
              to={`/inventory/${ticket.equipment.id}`}
              className="text-foreground hover:underline"
            >
              {ticket.equipment.name ??
                ticket.equipment.assetTag ??
                t("tickets.detail.unnamedEquipment")}
            </Link>
          </span>
        ) : null}
        {ticket.reporter ? (
          <span>
            {t("tickets.detail.reportedBy")} {ticket.reporter.initials ?? ticket.reporter.name}
          </span>
        ) : null}
      </div>

      {ticket.description ? (
        <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
      ) : null}

      {/* Task harmony: the ticket's PRIMARY task, any other tasks that
          link here, or the form to raise one — title/body/assignees/priority
          are copied, both link columns are set in one transaction. */}
      <Card className="flex flex-col gap-2 p-4">
        <p className="text-base font-semibold">{t("tickets.detail.tasks")}</p>
        {ticket.task ? (
          <p className="flex flex-wrap items-center gap-x-1 text-sm">
            {t("tickets.detail.primaryTask")}{" "}
            <Link to={`/tasks/${ticket.task.id}`} className="hover:underline">
              {ticket.task.title}
            </Link>{" "}
            <StatusBadge kind="task" value={ticket.task.status} />
          </p>
        ) : null}
        {ticket.linkedTasks
          .filter((linked) => linked.id !== ticket.task?.id)
          .map((linked) => (
            <p key={linked.id} className="flex flex-wrap items-center gap-x-1 text-sm">
              {t("tickets.detail.linkedTask")}{" "}
              <Link to={`/tasks/${linked.id}`} className="hover:underline">
                {linked.title}
              </Link>{" "}
              <StatusBadge kind="task" value={linked.status} />
            </p>
          ))}
        {!ticket.task && ticket.linkedTasks.length === 0 ? (
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="_action" value="raise-task" />
            <Select
              name="projectId"
              aria-label={t("tickets.detail.projectOptional")}
              className="max-w-[16rem]"
            >
              <option value="">{t("tickets.detail.noProject")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="tertiary" size="compact" disabled={busy}>
              {t("tickets.detail.raiseTask")}
            </Button>
          </Form>
        ) : null}
      </Card>

      {ticket.status === "RESOLVED" && ticket.resolution ? (
        <section className="bg-status-operational/15 shadow-surface-2 rounded-lg p-4">
          <p className="text-base font-semibold">{t("tickets.detail.resolution")}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{ticket.resolution}</p>
        </section>
      ) : null}

      {/* Workflow transitions */}
      <Card className="flex flex-col gap-3 p-4">
        <p className="text-base font-semibold">{t("tickets.detail.changeStatus")}</p>
        {actionData && "formError" in actionData && actionData.formError ? (
          <p className="text-destructive text-sm" role="alert">
            {actionData.formError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {ticket.status === "OPEN" ? (
            <TransitionButton
              status="IN_PROGRESS"
              label={t("tickets.detail.takeInProgress")}
              busy={busy}
            />
          ) : null}
          {ticket.status === "OPEN" || ticket.status === "IN_PROGRESS" ? (
            <TransitionButton
              status="CANCELLED"
              label={t("common.cancel")}
              variant="tertiary"
              busy={busy}
            />
          ) : null}
          {ticket.status === "RESOLVED" || ticket.status === "CANCELLED" ? (
            <TransitionButton
              status="OPEN"
              label={t("tickets.detail.reopen")}
              variant="tertiary"
              busy={busy}
            />
          ) : null}
        </div>

        {ticket.status === "OPEN" || ticket.status === "IN_PROGRESS" ? (
          <Form method="post" className="flex flex-col gap-2 border-t pt-3">
            <input type="hidden" name="_action" value="transition" />
            <input type="hidden" name="status" value="RESOLVED" />
            <Label htmlFor="resolution">{t("tickets.detail.markResolved")}</Label>
            <Textarea
              id="resolution"
              name="resolution"
              rows={2}
              placeholder={t("tickets.detail.resolutionPlaceholder")}
            />
            {actionData?.fieldErrors?.resolution ? (
              <p className="text-destructive text-xs" role="alert">
                {actionData.fieldErrors.resolution[0]}
              </p>
            ) : null}
            <Button type="submit" disabled={busy} className="self-start">
              {t("tickets.detail.resolve")}
            </Button>
          </Form>
        ) : null}
      </Card>

      {/* Content edit */}
      <details className="bg-card shadow-surface-2 rounded-lg p-4">
        <summary className="cursor-pointer text-base font-semibold">
          {t("tickets.detail.edit")}
        </summary>
        <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
          <input type="hidden" name="_action" value="update" />
          <TicketFormFields
            mode="edit"
            rooms={rooms}
            equipment={equipment}
            users={users}
            defaults={defaults}
          />
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("tickets.detail.saveChanges")}
          </Button>
        </ZodForm>
      </details>

      {/* Attachments */}
      <Card className="flex flex-col gap-3 p-4">
        <p className="text-base font-semibold">{t("tickets.detail.photos")}</p>
        <AttachmentGallery attachments={attachments} redirectTo={`/tickets/${ticket.id}`} />
        <FileUpload
          target={{ ticketId: ticket.id }}
          categories={[AttachmentCategory.TICKET]}
          redirectTo={`/tickets/${ticket.id}`}
        />
      </Card>

      {/* Per-entity history */}
      <Card>
        <CardHeader>
          <CardTitle>{t("tickets.detail.history")}</CardTitle>
        </CardHeader>
        <ActivityFeed entries={history} />
      </Card>
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
  variant?: "tertiary";
  busy: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="_action" value="transition" />
      <input type="hidden" name="status" value={status} />
      <Button type="submit" variant={variant} disabled={busy}>
        {label}
      </Button>
    </Form>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
