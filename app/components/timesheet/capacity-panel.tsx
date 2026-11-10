import { Link } from "react-router";
import { EmptyState } from "~/components/states/empty-state";
import { Gauge } from "lucide-react";
import type { getCapacityOverview } from "~/domains/tasks/tasks.queries.server";
import { formatHM } from "~/domains/time/time-utils";
import { dayIndexToDateKey } from "~/lib/berlin-days";
import { useT } from "~/i18n/use-t";

/**
 * The workload heatmap, rendered as the capacity tab of `/timesheet`
 * (`/timesheet?tab=capacity`). `/capacity` used to be its own page; it now
 * redirects here, so this module keeps the old URL alive through the tab.
 * Every active user × the next 6 ISO weeks (Berlin). Each cell shows the
 * open-task demand as a bar against the user's `weeklyCapacityMinutes`;
 * over capacity → destructive. Users with no capacity set show demand only —
 * never a fake 0 h.
 */
export function CapacityPanel({
  overview,
}: {
  overview: Awaited<ReturnType<typeof getCapacityOverview>>;
}) {
  const t = useT();
  const weeks = overview.weeks.map((w) => ({
    isoWeek: w.isoWeek,
    startKey: dayIndexToDateKey(w.startDay),
    current: overview.todayIndex >= w.startDay && overview.todayIndex < w.startDay + 7,
  }));
  const rows = overview.rows.map((r) => ({
    ...r,
    weeks: r.weeks.map((w) => ({
      ...w,
      pct: r.capacityMinutes != null ? Math.min(100, (w.demand / r.capacityMinutes) * 100) : null,
    })),
  }));

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold">{t("nav.capacity")}</h1>
        <p className="text-muted-foreground mt-1">{t("capacity.subtitle")}</p>
      </header>

      <section className="bg-card shadow-surface-2 overflow-x-auto rounded-lg">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-xs">
              <th className="w-[20%] p-2">{t("capacity.col.person")}</th>
              {weeks.map((w) => (
                <th
                  key={w.isoWeek}
                  className={`w-[11.5%] p-2 text-right ${w.current ? "text-foreground" : ""}`}
                >
                  {w.isoWeek.replace("-", " ")}
                  <span className="nums block font-normal whitespace-nowrap">
                    {w.startKey.slice(5)}
                  </span>
                </th>
              ))}
              <th className="w-[11%] p-2 text-right">{t("capacity.col.noDue")}</th>
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
                <tr key={r.userId} className="border-t align-top">
                  <td className="p-2">
                    <Link
                      to={`/tasks?assignee=${r.userId}`}
                      className="block truncate font-semibold hover:underline"
                      title={r.name}
                      aria-label={t("capacity.tasksOf", { name: r.name })}
                    >
                      {r.name}
                    </Link>
                    <div className="text-muted-foreground nums text-xs">
                      {r.capacityMinutes != null
                        ? t("capacity.perWeek", { hours: formatHM(r.capacityMinutes) })
                        : t("capacity.noCapacity")}
                    </div>
                  </td>
                  {r.weeks.map((w, i) => (
                    <td
                      key={w.isoWeek}
                      className={`nums p-2 text-right ${weeks[i]?.current ? "bg-tint" : ""}`}
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
                        <div className="text-destructive text-xs font-semibold">
                          {t("capacity.over")}
                        </div>
                      ) : null}
                    </td>
                  ))}
                  <td className="nums p-2 text-right">
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
