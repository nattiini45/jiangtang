import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useT } from "~/i18n/use-t";
import { ChartCard } from "./chart-card";

/**
 * Vertical-bar analytics panel. Mono axis labels to match the
 * industrial token set. Consumers pass a `data` array + the value/label keys.
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
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis
              dataKey={labelKey}
              tick={{ fontSize: 11, fontFamily: "monospace" }}
              angle={angleLabels ? -35 : 0}
              textAnchor={angleLabels ? "end" : "middle"}
              height={angleLabels ? 50 : 30}
              interval={0}
            />
            <YAxis tick={{ fontSize: 11, fontFamily: "monospace" }} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: "var(--muted)", fillOpacity: 0.3 }}
              contentStyle={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 2,
                fontSize: 12,
                fontFamily: "monospace",
              }}
              formatter={(value) => [`${value}${unit ? ` ${unit}` : ""}`, title]}
            />
            <Bar dataKey={valueKey} fill="var(--primary)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
