import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { TaskStatus } from "~/generated/prisma/enums";
import { requireUser } from "~/lib/auth.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import { berlinDayKey } from "~/domains/tasks/tasks.dates";
import { SETTLED_TASK_STATUSES } from "~/domains/tasks/tasks.lanes";
import { listTasks } from "~/domains/tasks/tasks.queries.server";
import { listProjectOptions } from "~/domains/projects/projects.queries.server";
import { listUsers } from "~/domains/auth/users.queries.server";
import { DataGrid } from "~/components/data-grid";
import { taskColumns } from "~/components/tasks/task-columns";
import { TASK_STATUSES, taskStatusLabel } from "~/components/tasks/labels";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { EmptyState } from "~/components/states/empty-state";
import { ListTodo } from "lucide-react";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/tasks` — the flat task list. The filters live in the URL and nowhere
 * else, and every garbage value degrades to "unfiltered" rather than throwing
 * (the `list-filter-parsing` contract, same as `/projects`):
 *
 * - `status` — `offen` (the DEFAULT: not DONE/CANCELLED), `alle`, or one enum
 *   value. Anything else → unfiltered.
 * - `assignee` — a user id or `me`; an unknown id → unfiltered.
 * - `project` — the project SLUG; an unknown slug → unfiltered.
 * - `due` — `overdue` (Berlin due day < today, open tasks only), `today`
 *   (due today), `week` (due in the next 7 Berlin days).
 * - `label`, `q` — free text.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "tasks.meta.list") }];
}

/** The statuses "offen" means — everything that is not DONE or CANCELLED. */
const OPEN_STATUSES = Object.values(TaskStatus).filter((s) => !SETTLED_TASK_STATUSES.has(s));

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  const url = new URL(request.url);
  const p = (name: string) => url.searchParams.get(name)?.trim() || undefined;

  const [projects, users] = await Promise.all([listProjectOptions(), listUsers()]);

  const statusParam = p("status") ?? "offen";
  let statuses: TaskStatus[] | undefined;
  if (statusParam === "offen") statuses = [...OPEN_STATUSES];
  else if (statusParam === "alle") statuses = undefined;
  else
    statuses = Object.values(TaskStatus).includes(statusParam as TaskStatus)
      ? [statusParam as TaskStatus]
      : undefined;

  const dueParam = p("due");
  // Berlin-day anchors: a due window is a range of Berlin CALENDAR days, so the
  // bounds are Berlin midnights — `berlinDayKey` for "which day is today" and
  // `berlinLocalToUtc` to turn it back into the instant the DB compares.
  const todayStart = berlinLocalToUtc(`${berlinDayKey(new Date())}T00:00`);
  const dayMs = 86_400_000;
  let dueFrom: Date | undefined;
  let dueTo: Date | undefined;
  if (dueParam === "overdue") {
    dueTo = new Date(todayStart.getTime() - 1);
    // "Overdue" only makes sense for open work — constrain the status set even
    // when the user asked for `alle`.
    statuses = statuses
      ? statuses.filter((s) => !SETTLED_TASK_STATUSES.has(s))
      : [...OPEN_STATUSES];
  } else if (dueParam === "today") {
    dueFrom = todayStart;
    dueTo = new Date(todayStart.getTime() + dayMs - 1);
  } else if (dueParam === "week") {
    dueFrom = todayStart;
    dueTo = new Date(todayStart.getTime() + 7 * dayMs - 1);
  }

  const assigneeParam = p("assignee");
  const assigneeId =
    assigneeParam === "me"
      ? actor.id
      : assigneeParam && users.some((u) => u.id === assigneeParam)
        ? assigneeParam
        : undefined;

  const projectParam = p("project");
  const projectId = projectParam ? projects.find((x) => x.slug === projectParam)?.id : undefined;

  const tasks = await listTasks({
    projectId,
    statuses,
    assigneeId,
    label: p("label"),
    q: p("q"),
    dueFrom,
    dueTo,
  });

  return {
    tasks,
    projects,
    users: users.filter((u) => u.isActive),
    filters: {
      project: projectParam ?? "",
      status: statusParam,
      assignee: assigneeParam ?? "",
      label: p("label") ?? "",
      q: p("q") ?? "",
      due: dueParam ?? "",
    },
  };
}

export default function TasksIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => taskColumns(t), [t]);
  const { tasks, projects, users, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl">{t("tasks.list.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("tasks.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/tasks/import">{t("tasks.list.import")}</Link>
          </Button>
          <Button asChild>
            <Link to="/tasks/new">{t("tasks.list.new")}</Link>
          </Button>
        </div>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-3">
        <Input
          name="q"
          defaultValue={filters.q}
          placeholder={t("tasks.list.searchPlaceholder")}
          className="max-w-[16rem]"
          aria-label={t("tasks.list.searchLabel")}
        />
        <Select
          name="status"
          defaultValue={filters.status}
          className="max-w-[14rem]"
          onChange={autoSubmit}
          aria-label={t("tasks.list.filterStatus")}
        >
          <option value="offen">{t("tasks.list.statusOpen")}</option>
          <option value="alle">{t("tasks.list.statusAll")}</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {taskStatusLabel(locale, s)}
            </option>
          ))}
        </Select>
        <Select
          name="assignee"
          defaultValue={filters.assignee}
          className="max-w-[14rem]"
          onChange={autoSubmit}
          aria-label={t("tasks.list.filterAssignee")}
        >
          <option value="">{t("tasks.list.assigneeAll")}</option>
          <option value="me">{t("tasks.list.assigneeMe")}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Select
          name="project"
          defaultValue={filters.project}
          className="max-w-[16rem]"
          onChange={autoSubmit}
          aria-label={t("tasks.list.filterProject")}
        >
          <option value="">{t("tasks.list.projectAll")}</option>
          {projects.map((proj) => (
            <option key={proj.id} value={proj.slug}>
              {proj.name}
            </option>
          ))}
        </Select>
        <Input
          name="label"
          defaultValue={filters.label}
          placeholder={t("tasks.list.labelPlaceholder")}
          className="max-w-[10rem]"
          aria-label={t("tasks.list.filterLabel")}
        />
        <Select
          name="due"
          defaultValue={filters.due}
          className="max-w-[12rem]"
          onChange={autoSubmit}
          aria-label={t("tasks.list.filterDue")}
        >
          <option value="">{t("tasks.list.dueAny")}</option>
          <option value="overdue">{t("tasks.list.dueOverdue")}</option>
          <option value="today">{t("tasks.list.dueToday")}</option>
          <option value="week">{t("tasks.list.dueWeek")}</option>
        </Select>
        <Button type="submit" variant="outline" size="sm">
          {t("tasks.list.filterSubmit")}
        </Button>
      </Form>

      <DataGrid
        columns={columns}
        data={tasks}
        getRowId={(r) => r.id}
        emptyMessage={
          <EmptyState
            icon={ListTodo}
            title={t("tasks.list.emptyTitle")}
            hint={t("tasks.list.emptyHint")}
            action={{ to: "/tasks/new", label: t("tasks.list.emptyAction") }}
            className="border-0"
          />
        }
        maxHeight={640}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
