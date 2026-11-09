import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { toErrorResponse, TransitionError, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { z } from "zod";
import { LANES } from "~/domains/tasks/tasks.lanes";
import { listBoardTasks } from "~/domains/tasks/tasks.queries.server";
import { moveTask } from "~/domains/tasks/tasks.mutations.server";
import { taskMoveSchema } from "~/domains/tasks/tasks.schema";
import { moveTicketToLane } from "~/domains/tickets/tickets.mutations.server";
import { ticketAllowedActions } from "~/domains/tickets/tickets.transitions";
import { ticketTransitionSchema } from "~/domains/tickets/tickets.schema";
import { listWorkTickets } from "~/domains/board/board.queries.server";
import { listProjectOptions } from "~/domains/projects/projects.queries.server";
import { listUsers } from "~/domains/auth/users.queries.server";
import { TaskBoard, type BoardLanes, type BoardTicketLanes } from "~/components/board/board";
import type { BoardCard } from "~/components/board/task-card";
import type { BoardTicket } from "~/components/board/ticket-card";
import { Select } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/board` — the task kanban. The loader groups `listBoardTasks` into
 * the five lanes; the filters (`project` slug, `assignee` id or `me`) live in
 * the URL and degrade to unfiltered on garbage, same as `/tasks`.
 *
 * The action speaks the `useFetcher` contract, NOT the document contract: it
 * answers `{ok}`/`{error}` JSON for the board's optimistic drop — a redirect
 * would tear the whole page down for a move that already happened visually.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "board.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  const url = new URL(request.url);
  const p = (name: string) => url.searchParams.get(name)?.trim() || undefined;

  const [projects, users] = await Promise.all([listProjectOptions(), listUsers()]);

  const assigneeParam = p("assignee");
  const assigneeId =
    assigneeParam === "me"
      ? actor.id
      : assigneeParam && users.some((u) => u.id === assigneeParam)
        ? assigneeParam
        : undefined;

  const projectParam = p("project");
  const projectId = projectParam ? projects.find((x) => x.slug === projectParam)?.id : undefined;

  const tasks = await listBoardTasks({ projectId, assigneeId });
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, [] as BoardCard[]])) as BoardLanes;
  for (const t of tasks) {
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

  // „Arbeitsmodus": tickets join the lanes — same filters, same
  // lane vocabulary, read through the `workitem` view.
  const mode = p("mode") === "work" ? "work" : "tasks";
  const ticketLanes = Object.fromEntries(
    LANES.map((lane) => [lane, [] as BoardTicket[]]),
  ) as BoardTicketLanes;
  if (mode === "work") {
    for (const t of await listWorkTickets({ projectId, assigneeId })) {
      ticketLanes[t.lane].push({
        id: t.id,
        shortId: t.shortId,
        title: t.title,
        type: t.type,
        status: t.status,
        allowedActions: ticketAllowedActions(t.status),
        priority: t.priority,
        room: t.room,
        assignees: t.assignees,
      });
    }
  }

  return {
    lanes,
    ticketLanes,
    projects,
    users: users.filter((u) => u.isActive),
    filters: { project: projectParam ?? "", assignee: assigneeParam ?? "", mode },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = Object.fromEntries((await request.formData()).entries());

  // Ticket move (work mode): lane change only — no neighbours, tickets
  // keep their view order inside a lane.
  if (form._action === "move-ticket") {
    const ticketId = safeParse(z.string().min(1), form.ticketId, locale);
    const lane = safeParse(z.enum(LANES), form.lane, locale);
    if (!ticketId.success || !lane.success) return { error: t(locale, "err.invalidInput") };
    try {
      const resolution = safeParse(
        ticketTransitionSchema.shape.resolution,
        form.resolution,
        locale,
      );
      if (!resolution.success) return { error: t(locale, "err.invalidInput") };
      await moveTicketToLane(actor, ticketId.data, lane.data, { resolution: resolution.data });
      await emitChange({ entityType: "ticket", id: ticketId.data, op: "updated" });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof ValidationError) {
        return {
          fieldErrors: e.fieldErrors,
          formErrors: e.formErrors,
          ...(e instanceof TransitionError ? { transition: e.transition } : {}),
          error:
            e.formErrors[0] ??
            Object.values(e.fieldErrors).flat()[0] ??
            t(locale, "err.board.moveRejected"),
        };
      }
      throw toErrorResponse(e);
    }
  }

  const taskId = safeParse(z.string().min(1), form.taskId, locale);
  const result = safeParse(taskMoveSchema, form, locale);
  if (!taskId.success || !result.success) {
    const fieldErrors = result.success ? {} : result.fieldErrors;
    const formErrors = result.success ? [] : result.formErrors;
    return {
      error: formErrors[0] ?? Object.values(fieldErrors).flat()[0] ?? t(locale, "err.invalidInput"),
    };
  }
  try {
    await moveTask(actor, taskId.data, result.data);
    await emitChange({ entityType: "task", id: taskId.data, op: "updated" });
    return { ok: true as const };
  } catch (e) {
    if (e instanceof ValidationError) {
      return {
        error:
          e.formErrors[0] ??
          Object.values(e.fieldErrors).flat()[0] ??
          t(locale, "err.board.moveRejected"),
      };
    }
    throw toErrorResponse(e);
  }
}

export default function Board({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const { lanes, ticketLanes, projects, users, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();
  const work = filters.mode === "work";
  const modeHref = (mode: string) => {
    const q = new URLSearchParams({ mode });
    if (filters.project) q.set("project", filters.project);
    if (filters.assignee) q.set("assignee", filters.assignee);
    return `/board?${q}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("board.list.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("board.list.subtitle")}</p>
        </div>
        <Form method="get" className="flex flex-wrap items-center gap-2">
          {work ? <input type="hidden" name="mode" value="work" /> : null}
          <Select
            name="project"
            defaultValue={filters.project}
            className="max-w-[16rem]"
            onChange={autoSubmit}
            aria-label={t("board.list.filterProject")}
          >
            <option value="">{t("board.list.projectAll")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.slug}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            name="assignee"
            defaultValue={filters.assignee}
            className="max-w-[14rem]"
            onChange={autoSubmit}
            aria-label={t("board.list.filterAssignee")}
          >
            <option value="">{t("board.list.assigneeAll")}</option>
            <option value="me">{t("board.list.assigneeMe")}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="tertiary" size="compact">
            {t("board.list.filterSubmit")}
          </Button>
          <Button type="button" variant={work ? "primary" : "tertiary"} size="compact" asChild>
            {/* aria-pressed is not allowed on <a>; the pressed state is visual
                (Button variant) plus an explicit label suffix. */}
            <Link to={modeHref(work ? "tasks" : "work")}>
              {t("board.list.workMode")}
              {work ? t("board.list.workModeActive") : ""}
            </Link>
          </Button>
        </Form>
      </div>

      <TaskBoard initialLanes={lanes} initialTickets={ticketLanes} />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
