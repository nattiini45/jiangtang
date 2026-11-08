import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useT } from "~/i18n/use-t";
import { ChartCard } from "./chart-card";

/**
 * Vertical-bar analytics panel. Consumers pass a `data` array + the value/label
 * keys. Colors are theme variables so the chart follows light and dark mode.
 */
export interface BarPanelProps {
  title: string;
  subtitle?: string;
  data: Array<Record<string, string | number>>;
  /** the categorical key on each datum (x-axis label). */
  labelKey: string;
  /** the numeric key on each datum (bar height). */
  valueKey: string;
  /** units suffix shown in the tooltip (already translated), e.g. "h" or "tickets". */
  unit?: string;
  /** rotate long labels. */
  angleLabels?: boolean;
}

const AXIS_TICK = { fontSize: 11, fill: "var(--chart-secondary)" };

export function BarPanel({
  title,
  subtitle,
  data,
  labelKey,
  valueKey,
  unit,
  angleLabels,
}: BarPanelProps) {
  const t = useT();
  const empty = data.length === 0;
  return (
    <ChartCard title={title} subtitle={subtitle}>
      {empty ? (
        <p className="text-muted-foreground flex h-full items-center justify-center text-sm">
          {t("analytics.noData")}
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, left: 0, bottom: angleLabels ? 40 : 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey={labelKey}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--chart-grid)" }}
              angle={angleLabels ? -35 : 0}
              textAnchor={angleLabels ? "end" : "middle"}
              height={angleLabels ? 50 : 30}
              interval={0}
            />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: "var(--tint)" }}
              itemStyle={{ color: "var(--popover-foreground)" }}
              contentStyle={{
                background: "var(--popover)",
                color: "var(--popover-foreground)",
                border: "none",
                borderRadius: 12,
                boxShadow: "var(--shadow-3)",
                fontSize: 12,
              }}
              formatter={(value) => [`${value}${unit ? ` ${unit}` : ""}`, title]}
            />
            <Bar dataKey={valueKey} fill="var(--chart-primary)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
