import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { buildGantt, type GanttTask } from "./gantt";
import { dayIndexToDateKey } from "~/lib/berlin-days";
import { StatusBadge } from "~/components/ui/status-badge";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Project gantt — hand-built SVG, no dependency. One row per task
 * (subtasks indented), bars in day units from `buildGantt`, week grid with
 * ISO `KW` labels, a today line, the project's own span as a band, and
 * dependency arrows blocker→blocked. Horizontal scroll handles long ranges.
 *
 * The task labels live in a separate `position: sticky` column left of the
 * chart SVG so the axis scrolls underneath them — week labels can never
 * render on top of the task titles. On mount the chart scrolls so today is
 * visible (falling back to the earliest dated task when today is outside the
 * range) instead of always opening at the axis start.
 */

const PX_PER_DAY = 26;
const ROW_H = 26;
const BAR_H = 12;
const LABEL_W = 260;
const HEADER_H = 30;
/** Days of left context kept before the scroll anchor. */
const ANCHOR_CONTEXT_DAYS = 8;

export function ProjectGantt({
  tasks,
  projectStartAt,
  projectDueAt,
}: {
  tasks: GanttTask[];
  projectStartAt?: Date | string | null;
  projectDueAt?: Date | string | null;
}) {
  const locale = useLocale();
  const t = useT();
  const layout = buildGantt({ tasks, projectStartAt, projectDueAt, locale });
  const chartW = (layout.endDay - layout.startDay + 1) * PX_PER_DAY;
  const chartH = layout.rows.length * ROW_H;
  const x = (day: number) => (day - layout.startDay) * PX_PER_DAY;
  const y = (row: number) => HEADER_H + row * ROW_H + ROW_H / 2;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || layout.rows.length === 0) return;
    const earliest = layout.rows.reduce<number | null>((min, row) => {
      const day = row.bar?.from ?? row.milestone ?? null;
      return day == null ? min : min == null || day < min ? day : min;
    }, null);
    const anchor = layout.today ?? earliest ?? layout.startDay;
    el.scrollLeft = Math.max(0, (anchor - layout.startDay - ANCHOR_CONTEXT_DAYS) * PX_PER_DAY);
  }, [layout]);

  return (
    <div>
      <div ref={scrollRef} className="bg-card shadow-surface-2 overflow-x-auto rounded-lg">
        <div className="flex" style={{ width: LABEL_W + chartW }}>
          {/* Sticky label column — a sibling of the chart SVG, not part of it,
              so the week axis starts at x=0 and can never overlap titles. */}
          <div
            className="border-border bg-card sticky left-0 z-10 shrink-0 border-r"
            style={{ width: LABEL_W }}
          >
            <svg
              aria-hidden="true"
              width={LABEL_W}
              height={HEADER_H + chartH + 8}
              className="block text-foreground"
            >
              <text x={8} y={HEADER_H - 10} fontSize={10} className="fill-(--chart-secondary)">
                {t("projects.gantt.taskColumn")}
              </text>
              {layout.rows.map((row, i) => (
                <text
                  key={row.task.id}
                  x={8 + row.depth * 16}
                  y={y(i) + 4}
                  fontSize={12}
                  className={row.done ? "fill-(--chart-secondary)" : "fill-foreground"}
                >
                  {row.task.title.length > 32 ? `${row.task.title.slice(0, 31)}…` : row.task.title}
                </text>
              ))}
            </svg>
          </div>

          <svg
            role="img"
            aria-label={t("projects.gantt.chartAria")}
            width={chartW}
            height={HEADER_H + chartH + 8}
            className="block shrink-0 text-foreground"
            style={{ minWidth: chartW }}
          >
            {/* header: ISO week labels */}
            <g>
              {layout.weeks.map((w) => (
                <g key={w.day}>
                  <line
                    x1={x(w.day)}
                    x2={x(w.day)}
                    y1={0}
                    y2={HEADER_H + chartH}
                    className="stroke-(--chart-grid)"
                    strokeWidth={1}
                  />
                  <text
                    x={Math.max(x(w.day), 0) + 4}
                    y={HEADER_H - 10}
                    className="fill-(--chart-secondary) nums"
                    fontSize={10}
                  >
                    {w.label}
                  </text>
                </g>
              ))}
            </g>

            {/* project start→due band */}
            {layout.projectBand ? (
              <rect
                x={x(layout.projectBand.from)}
                y={HEADER_H}
                width={(layout.projectBand.to - layout.projectBand.from) * PX_PER_DAY}
                height={chartH}
                className="fill-tint"
              />
            ) : null}

            {/* today line */}
            {layout.today != null ? (
              <line
                x1={x(layout.today + 0.5)}
                x2={x(layout.today + 0.5)}
                y1={0}
                y2={HEADER_H + chartH}
                className="stroke-(--chart-critical)"
                strokeWidth={1.5}
                strokeDasharray="4 2"
              />
            ) : null}

            {/* bars + milestones */}
            {layout.rows.map((row, i) => {
              const cy = y(i);
              return (
                <g key={row.task.id}>
                  {row.bar ? (
                    <g>
                      <rect
                        x={x(row.bar.from)}
                        y={cy - BAR_H / 2}
                        width={Math.max((row.bar.to - row.bar.from + 1) * PX_PER_DAY, 6)}
                        height={BAR_H}
                        rx={1}
                        className={
                          row.overdue
                            ? "fill-(--chart-critical)"
                            : row.done
                              ? "fill-(--chart-complete)"
                              : "fill-(--chart-primary)"
                        }
                      />
                      <Link
                        to={`/tasks/${row.task.id}`}
                        aria-label={t("projects.gantt.barAria", {
                          title: row.task.title,
                          from: dayIndexToDateKey(row.bar.from),
                          to: dayIndexToDateKey(row.bar.to),
                        })}
                      >
                        <rect
                          x={x(row.bar.from)}
                          y={cy - ROW_H / 2}
                          width={Math.max((row.bar.to - row.bar.from + 1) * PX_PER_DAY, 6)}
                          height={ROW_H}
                          fill="transparent"
                        />
                      </Link>
                    </g>
                  ) : row.milestone != null ? (
                    <Link
                      to={`/tasks/${row.task.id}`}
                      aria-label={t("projects.gantt.milestoneAria", {
                        title: row.task.title,
                        date: dayIndexToDateKey(row.milestone),
                      })}
                    >
                      <rect
                        x={x(row.milestone) + PX_PER_DAY / 2 - 8}
                        y={cy - 10}
                        width={16}
                        height={20}
                        fill="transparent"
                      />
                      <path
                        d={`M ${x(row.milestone) + PX_PER_DAY / 2} ${cy - 7} l 7 7 l -7 7 l -7 -7 z`}
                        className={
                          row.overdue
                            ? "fill-(--chart-critical)"
                            : row.done
                              ? "fill-(--chart-complete)"
                              : "fill-(--chart-primary)"
                        }
                      />
                    </Link>
                  ) : null}
                </g>
              );
            })}

            {/* dependency arrows: blocker bar end → blocked bar start */}
            {layout.arrows.map((a, i) => {
              const x0 = x(a.x0);
              const x1 = x(a.x1);
              const y0 = y(a.fromRow);
              const y1 = y(a.toRow);
              const midX = x1 > x0 ? (x0 + x1) / 2 : x0 + 10;
              return (
                <path
                  key={i}
                  d={`M ${x0} ${y0} H ${midX} V ${y1} H ${x1}`}
                  fill="none"
                  className="stroke-(--chart-secondary)"
                  strokeWidth={1.25}
                  markerEnd="url(#gantt-arrow)"
                />
              );
            })}
            <defs>
              <marker
                id="gantt-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="fill-(--chart-secondary)" />
              </marker>
            </defs>
          </svg>
        </div>
      </div>

      {layout.unscheduled.length > 0 ? (
        <section className="bg-card shadow-surface-2 mt-3 rounded-lg p-4">
          <h3 className="text-base font-semibold">{t("projects.gantt.unscheduled")}</h3>
          <ul className="mt-2 flex flex-col gap-1">
            {layout.unscheduled.map((t) => (
              <li key={t.id}>
                <Link to={`/tasks/${t.id}`} className="text-sm hover:underline">
                  {t.title}
                </Link>
                <StatusBadge kind="task" value={t.status} className="ml-2" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
