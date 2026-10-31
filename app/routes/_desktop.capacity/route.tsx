import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { EmptyState } from "~/components/states/empty-state";
import { Gauge } from "lucide-react";
import { getCapacityOverview } from "~/domains/tasks/tasks.queries.server";
import { formatHM } from "~/domains/time/time-utils";
import { dayIndexToDateKey } from "~/lib/berlin-days";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/capacity` — the workload heatmap: every active user × the
 * next 6 ISO weeks (Berlin). Each cell shows the open-task demand as a bar
 * against the user's `weeklyCapacityMinutes`; over capacity → destructive.
 * Users with no capacity set show demand only — never a fake 0 h.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "capacity.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const overview = await getCapacityOverview();
  return {
    weeks: overview.weeks.map((w) => ({
      isoWeek: w.isoWeek,
      startKey: dayIndexToDateKey(w.startDay),
      current: overview.todayIndex >= w.startDay && overview.todayIndex < w.startDay + 7,
    })),
    rows: overview.rows.map((r) => ({
      ...r,
      weeks: r.weeks.map((w) => ({
        ...w,
        pct: r.capacityMinutes != null ? Math.min(100, (w.demand / r.capacityMinutes) * 100) : null,
      })),
    })),
  };
}

export default function CapacityRoute() {
  const t = useT();
  const { weeks, rows } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-mono text-lg font-medium">{t("nav.capacity")}</h1>
        <p className="text-muted-foreground text-sm">{t("capacity.subtitle")}</p>
      </header>

      <section className="border-border overflow-x-auto border">
        <table className="w-full min-w-[64rem] text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-xs uppercase tracking-wide">
              <th className="p-2">{t("capacity.col.person")}</th>
              {weeks.map((w) => (
                <th
                  key={w.isoWeek}
                  className={`w-[13%] p-2 text-right ${w.current ? "text-foreground" : ""}`}
                >
                  {w.isoWeek.replace("-", " ")}
                  <span className="ml-1 font-mono font-normal normal-case">
                    {w.startKey.slice(5)}
                  </span>
                </th>
              ))}
              <th className="p-2 text-right">{t("capacity.col.noDue")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-2">
                  <EmptyState
                    icon={Gauge}
                    title={t("capacity.empty.title")}
                    hint={t("capacity.empty.hint")}
                    className="border-0"
                  />
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.userId} className="border-border border-t align-top">
                  <td className="p-2">
                    <Link
                      to={`/tasks?assignee=${r.userId}`}
                      className="font-medium hover:underline"
                      aria-label={t("capacity.tasksOf", { name: r.name })}
                    >
                      {r.name}
                    </Link>
                    <div className="text-muted-foreground font-mono text-xs">
                      {r.capacityMinutes != null
                        ? t("capacity.perWeek", { hours: formatHM(r.capacityMinutes) })
                        : t("capacity.noCapacity")}
                    </div>
                  </td>
                  {r.weeks.map((w, i) => (
                    <td
                      key={w.isoWeek}
                      className={`p-2 text-right font-mono ${weeks[i]?.current ? "bg-muted/30" : ""}`}
                    >
                      <div>
                        {w.demand > 0 ? formatHM(w.demand) : "—"}
                        {i === 0 && (w.logged ?? 0) > 0 ? (
                          <span className="text-muted-foreground ml-1 text-xs">
                            {t("capacity.logged", { hours: formatHM(w.logged ?? 0) })}
                          </span>
                        ) : null}
                      </div>
                      {w.pct != null ? (
                        <div
                          className="bg-muted mt-1 h-1.5 w-full"
                          role="meter"
                          aria-label={t("capacity.meter", { pct: Math.round(w.pct) })}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(w.pct)}
                        >
                          <div
                            className={`h-full ${w.over ? "bg-destructive" : "bg-primary"}`}
                            style={{ width: `${w.pct}%` }}
                          />
                        </div>
                      ) : (
                        <div className="text-muted-foreground mt-1 text-xs">—</div>
                      )}
                      {w.over ? (
                        <div className="text-destructive text-xs font-medium">
                          {t("capacity.over")}
                        </div>
                      ) : null}
                    </td>
                  ))}
                  <td className="p-2 text-right font-mono">
                    {r.noDueCount > 0 ? (
                      <span title={t("capacity.noDueTitle", { count: r.noDueCount })}>
                        {formatHM(r.noDue)}
                        <span className="text-muted-foreground text-xs"> ({r.noDueCount})</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
