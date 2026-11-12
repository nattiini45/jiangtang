import { Link } from "react-router";
import { OctagonAlert } from "lucide-react";
import { DateCell, StatusCell, type ColumnDef } from "~/components/data-grid";
import { TaskPriorityText } from "~/components/i18n/enum-text";
import { Badge } from "~/components/ui/badge";
import { isTaskOverdue } from "~/domains/tasks/tasks.dates";
import type { TaskPriority, TaskStatus } from "~/generated/prisma/client";
import type { Translate } from "~/i18n";

/**
 * DataGrid columns for `/tasks`. Project, assignees and the blocked
 * marker are columns because `listTasks` already joins/computes them — one
 * query, no N+1. The title cell links to `/tasks/:id`.
 *
 * The row type is hand-written, not derived from the query: `loaderData` is
 * serialized (turbo-stream), and a derived type carrying the Decimal `position`
 * would not survive serialization with its methods — the columns need none of
 * it. (`StockListRow` sets the precedent.)
 */

const dash = <span className="text-muted-foreground">—</span>;

/** The fields of a `listTasks` row the columns actually render. */
export interface TaskListRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority | null;
  dueAt: Date | null;
  labels: string[];
  isBlocked: boolean;
  project: { id: string; name: string; slug: string; color: string | null } | null;
  assignees: Array<{ userId: string; user: { id: string; name: string; initials: string | null } }>;
}

export function taskColumns(t: Translate): ColumnDef<TaskListRow>[] {
  return [
    {
      accessorKey: "title",
      header: t("tasks.col.title"),
      size: 300,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          {row.original.isBlocked ? (
            <OctagonAlert
              className="text-status-fault size-3.5 shrink-0"
              aria-label={t("tasks.col.blocked")}
              role="img"
            />
          ) : null}
          <Link to={`/tasks/${row.original.id}`} className="hover:underline">
            {row.original.title}
          </Link>
        </span>
      ),
    },
    {
      accessorKey: "status",
      meta: { searchText: (row) => t(`status.task.${row.status}`) },
      header: t("tasks.col.status"),
      size: 120,
      cell: ({ row }) => <StatusCell kind="task" value={row.original.status} />,
    },
    {
      accessorKey: "priority",
      meta: {
        searchText: (row) => (row.priority ? t(`status.taskPriority.${row.priority}`) : null),
      },
      header: t("tasks.col.priority"),
      size: 100,
      cell: ({ row }) =>
        row.original.priority ? (
          <span>
            <TaskPriorityText value={row.original.priority} />
          </span>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "assignees",
      meta: {
        searchText: (row) => row.assignees.map((a) => a.user.initials ?? a.user.name).join(" "),
      },
      header: t("tasks.col.assignees"),
      size: 120,
      cell: ({ row }) =>
        row.original.assignees.length > 0 ? (
          <span className="flex gap-1">
            {row.original.assignees.map((a) => (
              <Badge
                key={a.userId}
                title={a.user.name}
                className="type-micro h-5 rounded-full px-1.5 font-semibold"
              >
                {a.user.initials ?? a.user.name}
              </Badge>
            ))}
          </span>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "project",
      meta: { searchText: (row) => row.project?.name },
      header: t("tasks.col.project"),
      size: 180,
      cell: ({ row }) =>
        row.original.project ? (
          <Link to={`/projects/${row.original.project.slug}`} className="hover:underline">
            {row.original.project.color ? (
              <span
                aria-hidden
                className="mr-2 inline-block size-2.5 rounded-sm align-middle shadow-[inset_0_0_0_1px_var(--input)]"
                style={{ backgroundColor: row.original.project.color }}
              />
            ) : null}
            {row.original.project.name}
          </Link>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "dueAt",
      header: t("tasks.col.due"),
      size: 110,
      cell: ({ row }) =>
        row.original.dueAt ? (
          <span
            className={
              isTaskOverdue(row.original.dueAt, row.original.status)
                ? "text-status-fault"
                : undefined
            }
          >
            <DateCell value={row.original.dueAt} withTime={false} />
          </span>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "labels",
      meta: { searchText: (row) => row.labels.join(", ") },
      header: t("tasks.col.labels"),
      size: 160,
      cell: ({ row }) =>
        row.original.labels.length > 0 ? (
          <span className="text-muted-foreground">{row.original.labels.join(", ")}</span>
        ) : (
          dash
        ),
    },
  ];
}
