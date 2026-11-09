import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listTasks } from "~/domains/tasks/tasks.queries.server";
import { LANES, laneOfTaskStatus } from "~/domains/tasks/tasks.lanes";
import { taskStatusLabel } from "~/components/tasks/labels";
import { EmptyState } from "~/components/states/empty-state";
import { MobileRouteErrorBoundary as RouteErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
import { SegmentLink } from "~/components/ui/segment-link";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile board — read-only: the desktop lanes as stacked sections with
 * counts, "mine only" as a segmented filter. Cards tap through to `/m/tasks/:id`;
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
    <div className="flex flex-col gap-6 px-4 py-4">
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">{t("nav.board")}</h1>
        <div className="bg-tint flex rounded-full p-0.5">
          <SegmentLink to="/m/board" active={!mine} label={t("common.all")} />
          <SegmentLink to="/m/board?mine=1" active={mine} label={t("mobile.board.mineOnly")} />
        </div>
      </div>

      {lanes.map(({ lane, items }) => (
        <section key={lane} className="flex flex-col gap-2">
          <h2 className="flex items-baseline gap-2 text-base font-semibold">
            {t(`mobile.board.lane.${lane}`)}
            <span className="text-muted-foreground nums font-normal">{items.length}</span>
          </h2>
          <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
            {items.map((task) => (
              <li key={task.id}>
                <Link
                  to={`/m/tasks/${task.id}`}
                  className="active:bg-selected flex min-h-12 flex-col justify-center gap-0.5 px-3 py-2 transition-colors duration-80"
                >
                  <div className="whitespace-normal text-sm font-semibold">{task.title}</div>
                  <p className="text-muted-foreground nums whitespace-normal text-xs">
                    {[taskStatusLabel(locale, task.status), task.project?.name ?? null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </Link>
              </li>
            ))}
            {items.length === 0 ? (
              <li>
                <EmptyState title={t("mobile.board.empty")} className="py-4" />
              </li>
            ) : null}
          </ul>
        </section>
      ))}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
