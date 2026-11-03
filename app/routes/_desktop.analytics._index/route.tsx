import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import {
  failureRateByModel,
  resolutionTimes,
  roomUtilization,
  techWorkload,
} from "~/domains/analytics/analytics.queries.server";
import { BarPanel } from "~/components/charts/bar-panel";
import { RangePicker } from "~/components/analytics/range-picker";
import { EmptyChartState } from "~/components/analytics/empty-state";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { ticketTypeLabel } from "~/components/tickets/labels";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Analytics dashboards. Read-only aggregations over the
 * audit log, tickets, and equipment. ADMIN-only (internal operational data —
 * failure rates, tech workload — not for the whole team).
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");

  const url = new URL(request.url);
  // Utilization window: default last 90 days. Guard against non-numeric or
  // out-of-range `?days` values (NaN would produce an Invalid Date and crash
  // the Prisma query below).
  const rawDays = Number(url.searchParams.get("days"));
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 90;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const [models, resolutions, workload, utilization] = await Promise.all([
    failureRateByModel(),
    resolutionTimes(),
    techWorkload(),
    roomUtilization(from, to),
  ]);

  return { models, resolutions, workload, utilization, days };
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "analytics.meta") }];
}

export default function AnalyticsIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { models, resolutions, workload, utilization, days } = loaderData;

  const modelData = models.slice(0, 10).map((m) => ({
    label: m.modelName.length > 12 ? m.modelName.slice(0, 11) + "…" : m.modelName,
    value: Number(m.rate.toFixed(2)),
  }));
  const resolutionData = resolutions
    .filter((r) => r.medianHours !== null)
    .map((r) => ({ label: ticketTypeLabel(locale, r.type), value: Math.round(r.medianHours!) }));
  const workloadData = workload
    .slice(0, 12)
    .map((w) => ({ label: w.initials, value: w.closedCount }));
  const utilizationData = utilization.slice(0, 10).map((u) => ({
    label: u.roomName.length > 12 ? u.roomName.slice(0, 11) + "…" : u.roomName,
    value: Math.round(u.eventHours),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("nav.analytics")}</h1>
          <p className="text-muted-foreground mt-1">{t("analytics.subtitle")}</p>
        </div>
        <RangePicker days={days} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {modelData.length > 0 ? (
          <BarPanel
            title={t("analytics.failure.title")}
            subtitle={t("analytics.failure.subtitle")}
            data={modelData}
            labelKey="label"
            valueKey="value"
            unit={t("analytics.unit.perDevice")}
            angleLabels
          />
        ) : (
          <EmptyChartState
            title={t("analytics.failure.title")}
            subtitle={t("analytics.failure.subtitle")}
            hint={t("analytics.failure.empty")}
          />
        )}

        {resolutionData.length > 0 ? (
          <BarPanel
            title={t("analytics.resolution.title")}
            subtitle={t("analytics.resolution.subtitle")}
            data={resolutionData}
            labelKey="label"
            valueKey="value"
            unit={t("analytics.unit.hours")}
          />
        ) : (
          <EmptyChartState
            title={t("analytics.resolution.title")}
            subtitle={t("analytics.resolution.subtitle")}
            hint={t("analytics.resolution.empty")}
          />
        )}

        {workloadData.length > 0 ? (
          <BarPanel
            title={t("analytics.workload.title")}
            subtitle={t("analytics.workload.subtitle")}
            data={workloadData}
            labelKey="label"
            valueKey="value"
            unit={t("analytics.unit.tickets")}
          />
        ) : (
          <EmptyChartState
            title={t("analytics.workload.title")}
            subtitle={t("analytics.workload.subtitle")}
            hint={t("analytics.workload.empty")}
          />
        )}

        {utilizationData.length > 0 ? (
          <BarPanel
            title={t("analytics.utilization.title", { days })}
            subtitle={t("analytics.utilization.subtitle")}
            data={utilizationData}
            labelKey="label"
            valueKey="value"
            unit={t("analytics.unit.hours")}
            angleLabels
          />
        ) : (
          <EmptyChartState
            title={t("analytics.utilization.title", { days })}
            subtitle={t("analytics.utilization.subtitle")}
            hint={t("analytics.utilization.empty")}
          />
        )}
      </div>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
