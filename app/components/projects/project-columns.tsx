import { Link } from "react-router";
import { DateCell, StatusCell, type ColumnDef } from "~/components/data-grid";
import type { ProjectListRow } from "~/domains/projects/projects.queries.server";
import type { Translate } from "~/i18n";

/**
 * DataGrid columns for `/projects`. `lead` and `tasks` are columns because
 * `listProjects` already joins them — one query, no N+1, the same reason the
 * stock list's columns exist. The name cell links to `/projects/:slug`.
 *
 * A factory taking `t`: the headers and the task-count summary are localized.
 */

const dash = <span className="text-muted-foreground">—</span>;

export function projectColumns(t: Translate): ColumnDef<ProjectListRow>[] {
  return [
    {
      accessorKey: "name",
      header: t("projects.col.name"),
      cell: ({ row }) => (
        <Link to={`/projects/${row.original.slug}`} className="hover:underline">
          {row.original.color ? (
            <span
              aria-hidden
              className="mr-2 inline-block size-2.5 rounded-sm align-middle shadow-[inset_0_0_0_1px_var(--input)]"
              style={{ backgroundColor: row.original.color }}
            />
          ) : null}
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: "status",
      meta: { sizing: "short", searchText: (row) => t(`status.project.${row.status}`) },
      header: t("projects.col.status"),
      cell: ({ row }) => <StatusCell kind="project" value={row.original.status} />,
    },
    {
      accessorKey: "lead",
      meta: { searchText: (row) => row.lead?.name },
      header: t("projects.col.lead"),
      cell: ({ row }) =>
        row.original.lead ? <span className="text-sm">{row.original.lead.name}</span> : dash,
    },
    {
      accessorKey: "startAt",
      meta: { sizing: "short" },
      header: t("projects.col.startAt"),
      cell: ({ row }) => <DateCell value={row.original.startAt} withTime={false} />,
    },
    {
      accessorKey: "dueAt",
      meta: { sizing: "short" },
      header: t("projects.col.dueAt"),
      cell: ({ row }) => <DateCell value={row.original.dueAt} withTime={false} />,
    },
    {
      accessorKey: "tasks",
      meta: { sizing: "short" },
      header: t("projects.col.tasks"),
      cell: ({ row }) => {
        const tasks = row.original.tasks;
        return (
          <span className="nums text-sm">
            {t("projects.col.tasksDone", { done: tasks.done, total: tasks.total })}
            {tasks.open > 0 ? t("projects.col.tasksOpen", { open: tasks.open }) : ""}
          </span>
        );
      },
    },
  ];
}
