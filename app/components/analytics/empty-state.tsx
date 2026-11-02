import { ChartCard } from "~/components/charts/chart-card";
import { useT } from "~/i18n/use-t";

/**
 * Empty-state panel for an analytics section. Rendered in
 * place of a chart when that section's dataset is empty, so a blank-axis chart
 * never appears. Wrapped in the same `ChartCard` shell as the real charts so an
 * empty section keeps its titled frame and grid slot — one empty section must
 * not hide or shift the others.
 */
export function EmptyChartState({
  title,
  subtitle,
  hint,
}: {
  title: string;
  subtitle?: string;
  hint?: string;
}) {
  const t = useT();
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <div className="border-border text-muted-foreground flex h-full min-h-[200px] flex-col items-center justify-center gap-1 border border-dashed p-4 text-center">
        <p className="text-sm">{t("analytics.noData")}</p>
        <p className="text-xs">{hint ?? t("analytics.noDataHint")}</p>
      </div>
    </ChartCard>
  );
}
