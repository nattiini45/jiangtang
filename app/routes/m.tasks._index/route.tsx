import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listTasks } from "~/domains/tasks/tasks.queries.server";
import { taskStatusLabel } from "~/components/tasks/labels";
import { berlinDateInput } from "~/lib/format-date";
import { EmptyState } from "~/components/states/empty-state";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { ListTodo } from "lucide-react";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile task list — my open tasks by default, a segmented filter toggles to all
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
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("nav.tasks")}</h1>
        <Button asChild className="min-h-11">
          <Link to="/m/tasks/new">{t("mobile.tasks.new")}</Link>
        </Button>
      </div>

      <div className="bg-tint flex rounded-full p-0.5">
        <SegmentLink to="/m/tasks" active={!all} label={t("mobile.tasks.mine")} />
        <SegmentLink to="/m/tasks?all=1" active={all} label={t("mobile.tasks.allOpen")} />
      </div>

      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {tasks.map((task) => (
          <li key={task.id}>
            <Link
              to={`/m/tasks/${task.id}`}
              className="active:bg-selected flex min-h-12 flex-col justify-center gap-0.5 px-3 py-2 transition-colors duration-80"
            >
              <div className="truncate text-sm font-semibold">{task.title}</div>
              <p className="text-muted-foreground nums truncate text-xs">
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
          <li>
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

/** One option of a segmented filter: the selected segment is a raised card. */
function SegmentLink({ to, active, label }: { to: string; active: boolean; label: string }) {
  return (
    <Link
      to={to}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex min-h-11 flex-1 items-center justify-center rounded-full px-3 text-center text-sm transition-colors duration-80",
        active ? "bg-card shadow-surface-1 font-semibold" : "text-muted-foreground",
      )}
    >
      {label}
    </Link>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
