import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { z } from "zod";
import { TicketType } from "~/generated/prisma/enums";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { berlinDateInput } from "~/lib/format-date";
import { berlinLocalString } from "~/lib/berlin-days";
import {
  deleteTask,
  setTaskAssignees,
  setTaskStatus,
  updateTask,
} from "~/domains/tasks/tasks.mutations.server";
import { addTaskBlocker, removeTaskBlocker } from "~/domains/tasks/tasks.dependencies.server";
import { raiseTicketFromTask, unlinkTicket } from "~/domains/tasks/tasks.harmony.server";
import { getTask, listOpenTaskOptions } from "~/domains/tasks/tasks.queries.server";
import { getRunningEntry } from "~/domains/time/time.queries.server";
import { startTimer, stopTimer } from "~/domains/time/time.mutations.server";
import {
  taskAssigneesSchema,
  taskEditSchema,
  taskStatusSchema,
} from "~/domains/tasks/tasks.schema";
import { listProjectOptions } from "~/domains/projects/projects.queries.server";
import { listLocationOptions } from "~/domains/locations/locations.queries.server";
import { listUsers } from "~/domains/auth/users.queries.server";
import { listEntityHistory } from "~/domains/tickets/tickets.history.server";
import { ZodForm } from "~/components/forms";
import { TaskFormFields } from "~/components/tasks/task-form-fields";
import { TaskFormErrors } from "~/components/tasks/task-form-errors";
import { TaskDependencies } from "~/components/tasks/task-dependencies";
import { TaskAssigneesEditor } from "~/components/tasks/task-assignees-editor";
import { TaskTicketPanel } from "~/components/tasks/task-ticket-panel";
import { TASK_STATUSES, taskStatusLabel, taskPriorityLabel } from "~/components/tasks/labels";
import { ActivityFeed } from "~/components/history/activity-feed";
import { StatusCell, DateCell } from "~/components/data-grid";
import { isTaskOverdue } from "~/domains/tasks/tasks.dates";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/tasks/:id` — the task detail page. One `action` dispatches on the
 * hidden `_action` field (the `_desktop.inventory.stock.$id` convention):
 *
 * - `update` — content fields only (`taskEditSchema`; status/position are NOT
 *   editable here — transitions are their own audited verbs).
 * - `status` — `setTaskStatus`; a transition audits `TaskStatusChanged` and
 *   drops the card at the end of the new lane.
 * - `assignees` — `setTaskAssignees` replaces the whole set; the form submits
 *   `assigneeUser`/`assigneeEstimate` pairs zipped by row.
 * - `blocker-add` / `blocker-remove` — the dependency edge; a cycle refusal
 *   comes back as a form error, not a 422 page.
 * - `ticket-raise` / `ticket-unlink` — the ticket-harmony writes.
 * - `delete` — refused while subtasks exist; the refusal renders as a form
 *   error here, not an error boundary.
 * - `assign-me` / `set-status` — the command-palette verbs' intents. `assign-me`
 *   adds the actor to the assignee set (keeping the others); `set-status` is
 *   the same transition the `status` intent runs, posted by the verb's
 *   fetcher rather than the form.
 */
export const handle = { palette: "task" };

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "tasks.meta.detail", {
        name: data?.task.title ?? t(locale, "tasks.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const task = await getTask(params.id);
  if (!task) throw toErrorResponse(new NotFoundError(t(locale, "err.task.notFound")));
  const [users, projects, parents, locations, openTasks, history, runningTimer] = await Promise.all(
    [
      listUsers(),
      listProjectOptions(),
      listOpenTaskOptions(params.id),
      listLocationOptions(),
      listOpenTaskOptions(params.id),
      listEntityHistory("task", params.id),
      getRunningEntry(actor.id),
    ],
  );
  // Merge this task's (possibly deactivated) assignees into the picker so an
  // edit never silently drops them — the ticket detail page's convention.
  const byId = new Map(
    users
      .filter((u) => u.isActive)
      .map((u) => [u.id, { id: u.id, name: u.name, initials: u.initials }]),
  );
  for (const a of task.assignees) {
    if (!byId.has(a.user.id)) byId.set(a.user.id, a.user);
  }
  return {
    task,
    users: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "de")),
    projects,
    parents: parents.map((t) => ({ id: t.id, name: t.title })),
    locations,
    blockerOptions: openTasks.map((t) => ({ id: t.id, title: t.title })),
    history,
    runningTimer,
  };
}

/** The `assigneeUser`/`assigneeEstimate` form pairs → `TaskAssigneeInput[]`. */
function assigneesFromForm(form: FormData) {
  const userIds = form.getAll("assigneeUser").map(String);
  const estimates = form.getAll("assigneeEstimate").map(String);
  return userIds
    .map((userId, i) => ({ userId, estimateMinutes: estimates[i] ?? "" }))
    .filter((row) => row.userId.trim() !== "");
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "update");
  const id = params.id;
  const touched = (taskId: string) => emitChange({ entityType: "task", id: taskId, op: "updated" });
  try {
    switch (intent) {
      case "update": {
        const result = safeParse(taskEditSchema, { ...formDataToObject(form), id }, locale);
        if (!result.success)
          return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
        await updateTask(actor, id, result.data);
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "status": {
        const result = safeParse(taskStatusSchema, formDataToObject(form), locale);
        if (!result.success)
          return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
        await setTaskStatus(actor, id, result.data.status);
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "assignees": {
        const result = safeParse(taskAssigneesSchema, assigneesFromForm(form), locale);
        if (!result.success)
          return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
        await setTaskAssignees(actor, id, result.data);
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "assign-me": {
        // The palette's „Mir zuweisen" verb — add the actor, keep the rest.
        const task = await getTask(id);
        if (!task) throw new NotFoundError(t(locale, "err.task.notFound"));
        const assignees = [
          ...task.assignees.map((a) => ({
            userId: a.userId,
            estimateMinutes: a.estimateMinutes ?? undefined,
          })),
          { userId: actor.id },
        ].filter((a, i, all) => all.findIndex((b) => b.userId === a.userId) === i);
        await setTaskAssignees(actor, id, assignees);
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "set-status": {
        // The palette's „Status setzen: …" verbs — same transition as `status`.
        const result = safeParse(taskStatusSchema, formDataToObject(form), locale);
        if (!result.success)
          return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
        await setTaskStatus(actor, id, result.data.status);
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "start-timer": {
        const entry = await startTimer(actor, id);
        await emitChange({ entityType: "timeEntry", id: entry.id, op: "created" });
        return redirect(`/tasks/${id}`);
      }
      case "stop-timer": {
        const entry = await stopTimer(actor);
        await emitChange({ entityType: "timeEntry", id: entry.id, op: "updated" });
        return redirect(`/tasks/${id}`);
      }
      case "blocker-add": {
        const blockerTaskId = String(form.get("blockerTaskId") ?? "");
        await addTaskBlocker(actor, id, blockerTaskId);
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "blocker-remove": {
        const blockerTaskId = String(form.get("blockerTaskId") ?? "");
        await removeTaskBlocker(actor, id, blockerTaskId);
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "ticket-raise": {
        const parsed = safeParse(
          z.object({ type: z.enum(TicketType) }),
          formDataToObject(form),
          locale,
        );
        if (!parsed.success)
          return { fieldErrors: parsed.fieldErrors, formErrors: parsed.formErrors };
        const { ticket } = await raiseTicketFromTask(actor, id, { type: parsed.data.type });
        await emitChange({ entityType: "ticket", id: ticket.id, op: "created" });
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "ticket-unlink": {
        await unlinkTicket(actor, id);
        await touched(id);
        return redirect(`/tasks/${id}`);
      }
      case "delete": {
        await deleteTask(actor, id);
        await emitChange({ entityType: "task", id, op: "deleted" });
        return redirect("/tasks");
      }
      default:
        throw new ValidationError({}, [t(locale, "err.unknownActionNamed", { intent })]);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

export default function TaskDetail({ loaderData, actionData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { task, users, projects, parents, locations, blockerOptions, history, runningTimer } =
    loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const overdue = isTaskOverdue(task.dueAt, task.status);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold">{task.title}</h1>
          <StatusCell kind="task" value={task.status} />
          {task.priority ? (
            <span className="text-muted-foreground text-xs">
              {taskPriorityLabel(locale, task.priority)}
            </span>
          ) : null}
        </div>
        <Link to="/tasks" className="text-muted-foreground text-sm hover:underline">
          {t("tasks.detail.back")}
        </Link>
      </div>

      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {task.project ? (
          <span>
            {t("tasks.detail.project")}{" "}
            <Link to={`/projects/${task.project.slug}`} className="text-foreground hover:underline">
              {task.project.name}
            </Link>
          </span>
        ) : null}
        {task.parentTask ? (
          <span>
            {t("tasks.detail.parent")}{" "}
            <Link to={`/tasks/${task.parentTask.id}`} className="text-foreground hover:underline">
              {task.parentTask.title}
            </Link>
          </span>
        ) : null}
        {task.location ? (
          <span>
            {t("tasks.detail.location")} {task.location.name}
          </span>
        ) : null}
        {task.dueAt ? (
          <span className={overdue ? "text-status-fault" : undefined}>
            {t("tasks.detail.due")} <DateCell value={task.dueAt} withTime={false} />
            {overdue ? t("tasks.detail.overdue") : ""}
          </span>
        ) : null}
        {task.labels.length > 0 ? <span>{task.labels.join(", ")}</span> : null}
      </div>

      {task.body ? <p className="whitespace-pre-wrap text-sm">{task.body}</p> : null}

      <TaskFormErrors formErrors={actionData?.formErrors} />

      {/* Timer: start/stop from the task. A timer already running on a
          different task is named — starting here is refused server-side. */}
      <section className="bg-card shadow-surface-2 flex flex-wrap items-center gap-3 rounded-lg p-4">
        <h2 className="text-base font-semibold">{t("tasks.detail.timer.title")}</h2>
        {runningTimer?.taskId === task.id ? (
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="_action" value="stop-timer" />
            <Button type="submit" variant="secondary" size="compact" disabled={busy}>
              {t("tasks.detail.timer.stop")}
            </Button>
            <span className="text-muted-foreground nums text-xs">
              {t("tasks.detail.timer.runningSince", {
                time: berlinLocalString(runningTimer.startsAt).slice(11),
              })}
            </span>
          </Form>
        ) : (
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="_action" value="start-timer" />
            <Button type="submit" variant="secondary" size="compact" disabled={busy}>
              {t("tasks.detail.timer.start")}
            </Button>
            {runningTimer ? (
              <span className="text-muted-foreground text-xs">
                {t("tasks.detail.timer.otherRunning")}
              </span>
            ) : null}
          </Form>
        )}
        <Link to="/timesheet" className="text-muted-foreground text-xs hover:underline">
          {t("tasks.detail.timer.link")}
        </Link>
      </section>

      {/* Workflow transition */}
      <section className="bg-card shadow-surface-2 flex flex-wrap items-center gap-3 rounded-lg p-4">
        <h2 className="text-base font-semibold">{t("tasks.detail.status.title")}</h2>
        <Form method="post" className="flex items-center gap-2">
          <input type="hidden" name="_action" value="status" />
          <Select
            name="status"
            defaultValue={task.status}
            aria-label={t("tasks.detail.status.aria")}
            className="max-w-[14rem]"
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {taskStatusLabel(locale, s)}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary" size="compact" disabled={busy}>
            {t("tasks.detail.status.submit")}
          </Button>
        </Form>
      </section>

      {/* Assignees */}
      <section className="bg-card shadow-surface-2 flex flex-col gap-2 rounded-lg p-4">
        <h2 className="text-base font-semibold">{t("tasks.detail.assignees.title")}</h2>
        <Form method="post" className="flex flex-col gap-2">
          <input type="hidden" name="_action" value="assignees" />
          <TaskAssigneesEditor
            users={users}
            assignees={task.assignees.map((a) => ({
              userId: a.userId,
              estimateMinutes: a.estimateMinutes,
            }))}
          />
          <Button
            type="submit"
            variant="secondary"
            size="compact"
            className="self-start"
            disabled={busy}
          >
            {t("tasks.detail.assignees.submit")}
          </Button>
        </Form>
      </section>

      {/* Dependencies */}
      <section className="bg-card shadow-surface-2 rounded-lg p-4">
        <TaskDependencies
          taskId={task.id}
          blockers={task.blockedBy.map((e) => e.blocking)}
          blockedTasks={task.blocking.map((e) => e.blockedBy)}
          options={blockerOptions}
          fieldError={actionData?.fieldErrors?.blockerTaskId?.[0]}
          busy={busy}
        />
      </section>

      {/* Subtasks */}
      <section className="bg-card shadow-surface-2 flex flex-col gap-2 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t("tasks.detail.subtasks.title")}</h2>
          <Link to={`/tasks/new?parent=${task.id}`} className="text-sm hover:underline">
            {t("tasks.detail.subtasks.new")}
          </Link>
        </div>
        {task.subtasks.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("tasks.detail.subtasks.empty")}</p>
        ) : (
          <ul className="divide-y">
            {task.subtasks.map((sub) => (
              <li key={sub.id} className="flex items-center gap-2 py-2 text-sm">
                <Link to={`/tasks/${sub.id}`} className="hover:underline">
                  {sub.title}
                </Link>
                <StatusCell kind="task" value={sub.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Ticket harmony */}
      <section className="bg-card shadow-surface-2 flex flex-col gap-2 rounded-lg p-4">
        <h2 className="text-base font-semibold">{t("tasks.detail.ticket.title")}</h2>
        {task.primaryForTickets.length > 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("tasks.detail.ticket.primaryFor")}{" "}
            {task.primaryForTickets.map((tk) => (
              <Link
                key={tk.id}
                to={`/tickets/${tk.id}`}
                className="text-foreground hover:underline"
              >
                {tk.title}
              </Link>
            ))}
          </p>
        ) : null}
        <TaskTicketPanel ticket={task.ticket} busy={busy} />
      </section>

      {/* Content edit */}
      <details className="bg-card shadow-surface-2 rounded-lg p-4">
        <summary className="cursor-pointer text-base font-semibold">
          {t("tasks.detail.edit.title")}
        </summary>
        <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-3">
          <input type="hidden" name="_action" value="update" />
          <TaskFormFields
            defaults={{
              title: task.title,
              body: task.body,
              priority: task.priority,
              startAt: berlinDateInput(task.startAt),
              dueAt: berlinDateInput(task.dueAt),
              estimateMinutes: task.estimateMinutes,
              projectId: task.projectId,
              parentTaskId: task.parentTaskId,
              locationId: task.locationId,
              labels: task.labels,
            }}
            projects={projects}
            parents={parents}
            locations={locations}
          />
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("tasks.detail.edit.submit")}
          </Button>
        </ZodForm>
      </details>

      {/* Delete */}
      <section className="bg-card shadow-surface-2 rounded-lg p-4">
        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm(t("tasks.detail.delete.confirm"))) e.preventDefault();
          }}
        >
          <input type="hidden" name="_action" value="delete" />
          <Button type="submit" variant="destructive" disabled={busy}>
            {t("tasks.detail.delete.submit")}
          </Button>
        </Form>
      </section>

      {/* Per-entity history */}
      <section className="bg-card shadow-surface-2 rounded-lg">
        <header className="flex h-12 items-center px-4">
          <h2 className="text-base font-semibold">{t("tasks.detail.history.title")}</h2>
        </header>
        <ActivityFeed entries={history} />
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
