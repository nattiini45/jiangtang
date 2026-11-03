import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  burndownRange,
  computeBurndown,
  idealRemaining,
  type BurndownEvent,
  type BurndownTask,
} from "./gantt";
import { dayIndexFromCivil } from "~/lib/berlin-days";
import { ChartCard } from "~/components/charts/chart-card";
import { useT } from "~/i18n/use-t";

/**
 * Project burndown: remaining Σ estimateMinutes of open tasks per Berlin
 * day, reconstructed from the activity log, plus an ideal line from the
 * starting total to 0 at the project's dueAt.
 */
const AXIS_TICK = { fontSize: 10, fill: "var(--muted-foreground)" };

export function ProjectBurndown({
  tasks,
  events,
  projectStartAt,
  projectDueAt,
}: {
  tasks: BurndownTask[];
  events: BurndownEvent[];
  projectStartAt?: Date | string | null;
  projectDueAt?: Date | string | null;
}) {
  const t = useT();
  const { startDay, endDay, dueDay } = burndownRange({ tasks, projectStartAt, projectDueAt });
  const span = { startDay, endDay };

  const points = computeBurndown(tasks, events, span);
  const startRemaining = points[0]?.remaining ?? 0;
  const data = points.map((p) => ({
    day: p.day,
    remaining: p.remaining,
    ideal:
      dueDay != null
        ? Math.round(
            idealRemaining(startRemaining, span.startDay, dueDay, dayIndexFromDateKey(p.day)) ?? 0,
          )
        : null,
  }));

  // Whole-hour ticks: auto ticks land on arbitrary minute values ("33:20"), so
  // the axis is pinned to ~6 evenly spaced hour marks.
  const maxMinutes = Math.max(60, ...data.map((d) => Math.max(d.remaining, d.ideal ?? 0)));
  const maxHours = Math.ceil(maxMinutes / 60);
  const tickStep = Math.max(1, Math.ceil(maxHours / 6));
  const hourTicks: number[] = [];
  for (let h = 0; h <= maxHours; h += tickStep) hourTicks.push(h * 60);
  if (hourTicks[hourTicks.length - 1] !== maxHours * 60) hourTicks.push(maxHours * 60);

  return (
    <ChartCard
      title={t("projects.burndown.title")}
      subtitle={
        dueDay != null ? t("projects.burndown.subtitle") : t("projects.burndown.subtitleNoDue")
      }
    >
      {data.length === 0 ? (
        <p className="text-muted-foreground flex h-full items-center justify-center text-sm">
          {t("projects.burndown.empty")}
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="day"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tickFormatter={(d: string) => d.slice(5)}
              minTickGap={24}
            />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              ticks={hourTicks}
              domain={[0, hourTicks[hourTicks.length - 1]]}
              tickFormatter={(v: number) => `${Math.round(v / 60)}h`}
              width={40}
            />
            <Tooltip
              contentStyle={{
                background: "var(--popover)",
                color: "var(--popover-foreground)",
                border: "none",
                borderRadius: 12,
                boxShadow: "var(--shadow-3)",
                fontSize: 12,
              }}
              formatter={(value, name) => {
                const v = typeof value === "number" ? value : null;
                return [
                  v == null ? "—" : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")} h`,
                  name === "remaining"
                    ? t("projects.burndown.remaining")
                    : t("projects.burndown.ideal"),
                ];
              }}
              labelFormatter={(label) => String(label)}
            />
            <Line
              type="stepAfter"
              dataKey="remaining"
              name="remaining"
              stroke="var(--fluid-accent)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {dueDay != null ? (
              <Line
                type="linear"
                dataKey="ideal"
                name="ideal"
                stroke="var(--muted-foreground)"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

function dayIndexFromDateKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return dayIndexFromCivil(y, m, d);
}
