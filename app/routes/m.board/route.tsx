import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listTasks } from "~/domains/tasks/tasks.queries.server";
import { LANES, laneOfTaskStatus } from "~/domains/tasks/tasks.lanes";
import { taskStatusLabel } from "~/components/tasks/labels";
import { EmptyState } from "~/components/states/empty-state";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile board — read-only: the desktop lanes as stacked sections with
 * counts, "mine only" as a chip filter. Cards tap through to `/m/tasks/:id`;
 * dragging stays on the desktop where dnd-kit lives.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "board.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const mine = new URL(request.url).searchParams.get("mine") === "1";
  const tasks = await listTasks(mine ? { assigneeId: user.id } : {});
  const lanes = new Map<(typeof LANES)[number], typeof tasks>();
  for (const lane of LANES) lanes.set(lane, []);
  for (const t of tasks) lanes.get(laneOfTaskStatus(t.status))!.push(t);
  return { lanes: [...lanes.entries()].map(([lane, items]) => ({ lane, items })), mine };
}

export default function MobileBoard({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { lanes, mine } = loaderData;
  return (
    <div className="flex flex-col">
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <h1 className="font-mono text-lg">{t("nav.board")}</h1>
        <Link
          to={mine ? "/m/board" : "/m/board?mine=1"}
          className={
            mine
              ? "bg-primary text-primary-foreground flex min-h-11 items-center rounded-sm px-3 text-sm"
              : "border-border text-muted-foreground flex min-h-11 items-center rounded-sm border px-3 text-sm"
          }
        >
          {t("mobile.board.mineOnly")}
        </Link>
      </div>

      {lanes.map(({ lane, items }) => (
        <section key={lane} className="border-border border-b">
          <h2 className="text-muted-foreground flex items-baseline gap-2 px-4 pt-3 font-mono text-xs uppercase">
            {t(`mobile.board.lane.${lane}`)}
            <span className="text-foreground">{items.length}</span>
          </h2>
          <ul className="divide-border divide-y">
            {items.map((task) => (
              <li key={task.id}>
                <Link to={`/m/tasks/${task.id}`} className="active:bg-accent block px-4 py-3">
                  <div className="truncate text-base">{task.title}</div>
                  <p className="text-muted-foreground font-mono text-xs">
                    {[taskStatusLabel(locale, task.status), task.project?.name ?? null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </Link>
              </li>
            ))}
            {items.length === 0 ? (
              <li className="px-4 py-3">
                <EmptyState title={t("mobile.board.empty")} className="border-0 py-4" />
              </li>
            ) : null}
          </ul>
        </section>
      ))}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
