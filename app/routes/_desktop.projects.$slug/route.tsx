import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t, type MessageKey } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { getProjectBySlug } from "~/domains/projects/projects.queries.server";
import { listNotes } from "~/domains/notes/notes.queries.server";
import { projectStatusSchema } from "~/domains/projects/projects.schema";
import { setProjectStatus } from "~/domains/projects/projects.mutations.server";
import { listTaskStatusEvents } from "~/domains/activity/activity.queries.server";
import { listBoardTasks } from "~/domains/tasks/tasks.queries.server";
import { LANES } from "~/domains/tasks/tasks.lanes";
import { DateCell } from "~/components/data-grid";
import { StatusBadge } from "~/components/ui/status-badge";
import { projectStatusLabel, PROJECT_STATUSES } from "~/components/projects/labels";
import { ProjectFormErrors } from "~/components/projects/project-form-errors";
import { NoteList } from "~/components/notes/note-list";
import { TaskBoard, type BoardLanes } from "~/components/board/board";
import type { BoardCard } from "~/components/board/task-card";
import { ProjectGantt } from "~/components/projects/project-gantt";
import { ProjectBurndown } from "~/components/projects/project-burndown";
import type { BurndownEvent } from "~/components/projects/gantt";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/projects/:slug` — one project: header, a dedicated status-change form
 * (every transition is audited `ProjectStatusChanged`, which is why status is
 * not a field on the edit form), and the project's tasks as a simple table
 * linking `/tasks/:id`.
 *
 * The detail route keys on the **slug**, not the id — the slug is the shareable
 * URL ('s convention, same as `/rooms/:slug`).
 */
export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "projects.meta.detail", {
        name: data?.project.name ?? t(locale, "projects.meta.fallbackName"),
      }),
    },
  ];
}

type ProjectView = "overview" | "board" | "gantt" | "burndown";
const VIEWS: { id: ProjectView; labelKey: MessageKey }[] = [
  { id: "overview", labelKey: "projects.view.overview" },
  { id: "board", labelKey: "projects.view.board" },
  { id: "gantt", labelKey: "projects.view.gantt" },
  { id: "burndown", labelKey: "projects.view.burndown" },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const locale = resolveLocale(request);
  const project = await getProjectBySlug(params.slug);
  if (!project) throw toErrorResponse(new NotFoundError(t(locale, "err.project.notFound")));

  const viewParam = new URL(request.url).searchParams.get("view");
  const view: ProjectView =
    viewParam === "board" || viewParam === "gantt" || viewParam === "burndown"
      ? viewParam
      : "overview";

  const notes = view === "overview" ? await listNotes({ projectId: project.id }) : [];

  // Board tab: the same lanes `/board` builds, pre-filtered to this project.
  let lanes: BoardLanes | null = null;
  if (view === "board") {
    lanes = Object.fromEntries(LANES.map((lane) => [lane, [] as BoardCard[]])) as BoardLanes;
    for (const t of await listBoardTasks({ projectId: project.id })) {
      lanes[t.lane].push({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueAt: t.dueAt,
        labels: t.labels,
        isBlocked: t.isBlocked,
        project: t.project,
        assignees: t.assignees,
      });
    }
  }

  // Burndown tab: status history from the audit log (TaskCreated's `status`,
  // TaskStatusChanged's `to`, TaskMoved's `toStatus` — normalized to `to`).
  let events: BurndownEvent[] = [];
  if (view === "burndown") {
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    events = (await listTaskStatusEvents(project.tasks.map((t) => t.id))).map((r) => {
      const d = r.data as Record<string, unknown> | null;
      return {
        taskId: r.entityId,
        occurredAt: r.occurredAt,
        action: r.action,
        to:
          r.action === "TaskCreated"
            ? str(d?.status)
            : r.action === "TaskMoved"
              ? str(d?.toStatus)
              : str(d?.to),
      };
    });
  }

  return { project, notes, view, lanes, events };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  const project = await getProjectBySlug(params.slug);
  if (!project) throw toErrorResponse(new NotFoundError(t(locale, "err.project.notFound")));

  if (intent !== "status") {
    return { fieldErrors: {}, formErrors: [t(locale, "err.unknownAction")] };
  }

  const result = safeParse(
    projectStatusSchema,
    { ...formDataToObject(form), id: project.id },
    locale,
  );
  if (!result.success) {
    return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
  }
  try {
    const updated = await setProjectStatus(actor, project.id, result.data.status);
    await emitChange({ entityType: "project", id: updated.id, op: "updated" });
    return { fieldErrors: {}, formErrors: [], status: updated.status };
  } catch (e) {
    if (e instanceof ValidationError) {
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

const dash = <span className="text-muted-foreground">—</span>;

export default function ProjectDetail({ loaderData, actionData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { project, notes, view, lanes, events } = loaderData;
  const currentStatus = actionData?.status ?? project.status;

  const ganttTasks = project.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    startAt: t.startAt,
    dueAt: t.dueAt,
    parentTaskId: t.parentTaskId,
    blockerIds: t.blockedBy.map((b) => b.blockingTaskId),
  }));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-bold">
          {project.color ? (
            <span
              aria-hidden
              className="mr-2 inline-block size-3 rounded-sm align-middle"
              style={{ backgroundColor: project.color }}
            />
          ) : null}
          {project.name}
        </h1>
        <div className="flex items-center gap-3">
          <Link
            to={`/projects/${project.slug}/edit`}
            className="text-muted-foreground text-sm hover:underline"
          >
            {t("projects.detail.edit")}
          </Link>
          <Link to="/projects" className="text-muted-foreground text-sm hover:underline">
            {t("projects.detail.back")}
          </Link>
        </div>
      </div>

      <section className="bg-card shadow-surface-2 flex flex-wrap items-center gap-3 rounded-lg p-4">
        <StatusBadge kind="project" value={project.status} />
        {/* Status is its own form: the transition writes `ProjectStatusChanged`,
            so it must not be an editable field on the edit page. */}
        <Form method="post" className="flex items-center gap-2">
          <input type="hidden" name="_action" value="status" />
          <Select
            name="status"
            defaultValue={currentStatus}
            className="max-w-[16rem]"
            aria-label={t("projects.detail.statusAria")}
          >
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {projectStatusLabel(locale, s)}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="tertiary" size="compact">
            {t("projects.detail.setStatus")}
          </Button>
        </Form>
        <ProjectFormErrors formErrors={actionData?.formErrors} />
      </section>

      {/* View tabs — plain links so they are keyboard-reachable and the view
          lives in the URL (`?view=`), shareable like every other filter. */}
      <nav aria-label={t("projects.detail.viewNavAria")} className="flex border-b">
        {VIEWS.map((v) => (
          <Link
            key={v.id}
            to={v.id === "overview" ? `/projects/${project.slug}` : `?view=${v.id}`}
            aria-current={view === v.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              view === v.id
                ? "border-primary text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground border-transparent"
            }`}
          >
            {t(v.labelKey)}
          </Link>
        ))}
      </nav>

      {view === "board" && lanes ? (
        <TaskBoard initialLanes={lanes} dndId="project-task-board" submitAction="/board" />
      ) : null}

      {view === "gantt" ? (
        <ProjectGantt
          tasks={ganttTasks}
          projectStartAt={project.startAt}
          projectDueAt={project.dueAt}
        />
      ) : null}

      {view === "burndown" ? (
        <ProjectBurndown
          tasks={project.tasks}
          events={events}
          projectStartAt={project.startAt}
          projectDueAt={project.dueAt}
        />
      ) : null}

      {view !== "overview" ? null : (
        <>
          <section className="bg-card shadow-surface-2 grid grid-cols-2 gap-4 rounded-lg p-4 sm:grid-cols-3">
            <Field label={t("projects.detail.lead")}>
              {project.lead ? project.lead.name : dash}
            </Field>
            <Field label={t("projects.detail.startAt")}>
              <DateCell value={project.startAt} withTime={false} />
            </Field>
            <Field label={t("projects.detail.dueAt")}>
              <DateCell value={project.dueAt} withTime={false} />
            </Field>
            <Field label={t("projects.detail.parent")}>
              {project.parentProject ? (
                <Link to={`/projects/${project.parentProject.slug}`} className="hover:underline">
                  {project.parentProject.name}
                </Link>
              ) : (
                dash
              )}
            </Field>
          </section>

          {project.description ? (
            <section className="bg-card shadow-surface-2 rounded-lg p-4">
              <h2 className="text-base font-semibold">{t("projects.detail.description")}</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm">{project.description}</p>
            </section>
          ) : null}

          <section className="bg-card shadow-surface-2 rounded-lg p-4">
            <h2 className="text-base font-semibold">{t("projects.detail.subProjects")}</h2>
            {project.subProjects.length === 0 ? (
              <p className="text-muted-foreground mt-2 text-sm">
                {t("projects.detail.noSubProjects")}
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {project.subProjects.map((sub) => (
                  <li key={sub.id}>
                    <Link to={`/projects/${sub.slug}`} className="text-sm hover:underline">
                      {sub.name}
                    </Link>
                    <StatusBadge kind="project" value={sub.status} className="ml-2" />
                  </li>
                ))}
              </ul>
            )}
            <Button asChild variant="tertiary" size="compact" className="mt-3">
              <Link to={`/projects/new?parent=${project.id}`}>
                {t("projects.detail.newSubProject")}
              </Link>
            </Button>
          </section>

          <section className="bg-card shadow-surface-2 rounded-lg p-4">
            <h2 className="text-base font-semibold">{t("projects.detail.tasks")}</h2>
            {project.tasks.length === 0 ? (
              <p className="text-muted-foreground mt-2 text-sm">{t("projects.detail.noTasks")}</p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-left text-xs font-normal">
                    <th className="py-1 pr-3">{t("projects.detail.taskColumn")}</th>
                    <th className="py-1 pr-3">{t("projects.detail.statusColumn")}</th>
                    <th className="py-1">{t("projects.detail.dueColumn")}</th>
                  </tr>
                </thead>
                <tbody>
                  {project.tasks.map((task) => (
                    <tr key={task.id} className="border-t">
                      <td className="py-1 pr-3">
                        <Link to={`/tasks/${task.id}`} className="hover:underline">
                          {task.title}
                        </Link>
                      </td>
                      <td className="py-1 pr-3">
                        <StatusBadge kind="task" value={task.status} />
                      </td>
                      <td className="py-1">
                        <DateCell value={task.dueAt} withTime={false} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="bg-card shadow-surface-2 rounded-lg p-4">
            <h2 className="text-base font-semibold">{t("projects.detail.notes")}</h2>
            <div className="mt-2">
              <NoteList notes={notes} emptyMessage={t("projects.detail.noNotes")} />
            </div>
            <Button asChild variant="tertiary" size="compact" className="mt-3">
              <Link to={`/notes/new?project=${project.slug}`}>{t("projects.detail.newNote")}</Link>
            </Button>
          </section>
        </>
      )}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
