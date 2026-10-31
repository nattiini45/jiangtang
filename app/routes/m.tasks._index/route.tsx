import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listTasks } from "~/domains/tasks/tasks.queries.server";
import { taskStatusLabel } from "~/components/tasks/labels";
import { berlinDateInput } from "~/lib/format-date";
import { EmptyState } from "~/components/states/empty-state";
import { ListTodo } from "lucide-react";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile task list — my open tasks by default, a chip toggles to all
 * open. Thumb-friendly single column, tap through to `/m/tasks/:id` for the
 * quick actions. "New" leads to the capture form.
 */
const OPEN_STATUSES = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED"] as const;

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "tasks.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const all = new URL(request.url).searchParams.get("all") === "1";
  const tasks = await listTasks({
    statuses: [...OPEN_STATUSES],
    ...(all ? {} : { assigneeId: user.id }),
  });
  return { tasks, all };
}

export default function MobileTasksIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { tasks, all } = loaderData;
  return (
    <div className="flex flex-col">
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <h1 className="font-mono text-lg">{t("nav.tasks")}</h1>
        <Link
          to="/m/tasks/new"
          className="bg-primary text-primary-foreground flex min-h-11 items-center rounded-sm px-4 text-sm"
        >
          {t("mobile.tasks.new")}
        </Link>
      </div>

      <div className="border-border flex gap-2 border-b px-4 py-3">
        <Chip to="/m/tasks" active={!all} label={t("mobile.tasks.mine")} />
        <Chip to="/m/tasks?all=1" active={all} label={t("mobile.tasks.allOpen")} />
      </div>

      <ul className="divide-border divide-y">
        {tasks.map((task) => (
          <li key={task.id}>
            <Link to={`/m/tasks/${task.id}`} className="active:bg-accent block px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="truncate text-base">{task.title}</span>
              </div>
              <p className="text-muted-foreground font-mono text-xs">
                {[
                  taskStatusLabel(locale, task.status),
                  task.project?.name ?? null,
                  task.dueAt ? t("mobile.tasks.due", { date: berlinDateInput(task.dueAt) }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </Link>
          </li>
        ))}
        {tasks.length === 0 ? (
          <li className="p-4">
            <EmptyState
              icon={ListTodo}
              title={all ? t("mobile.tasks.emptyAll") : t("mobile.tasks.emptyMine")}
              action={{ to: "/m/tasks/new", label: t("mobile.tasks.create") }}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function Chip({ to, active, label }: { to: string; active: boolean; label: string }) {
  return (
    <Link
      to={to}
      className={
        active
          ? "bg-primary text-primary-foreground flex min-h-11 items-center rounded-sm px-3 text-sm"
          : "border-border text-muted-foreground flex min-h-11 items-center rounded-sm border px-3 text-sm"
      }
    >
      {label}
    </Link>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
