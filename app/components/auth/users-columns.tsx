import { Link } from "react-router";
import { MonoCell, type ColumnDef } from "~/components/data-grid";
import type { UserListRow } from "~/domains/auth/users.queries.server";
import { RoleText } from "~/components/i18n/enum-text";
import type { Translate } from "~/i18n";

const dash = <span className="text-muted-foreground">—</span>;

export const usersColumns = (t: Translate): ColumnDef<UserListRow>[] => [
  {
    accessorKey: "name",
    header: t("admin.users.col.name"),
    size: 200,
    cell: ({ row }) => (
      <Link to={`/admin/users/${row.original.id}`} className="hover:underline">
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "email",
    header: t("admin.users.col.email"),
    size: 240,
    cell: ({ row }) => <MonoCell>{row.original.email}</MonoCell>,
  },
  {
    accessorKey: "initials",
    header: t("admin.users.col.initials"),
    size: 100,
    cell: ({ row }) =>
      row.original.initials ? <MonoCell>{row.original.initials}</MonoCell> : dash,
  },
  {
    accessorKey: "role",
    header: t("admin.users.col.role"),
    size: 110,
    cell: ({ row }) => (
      <span className="text-muted-foreground font-mono text-xs">
        <RoleText role={row.original.role} />
      </span>
    ),
  },
  {
    id: "isActive",
    header: t("admin.users.col.status"),
    size: 120,
    cell: ({ row }) =>
      row.original.isActive ? (
        <span className="text-status-operational font-mono text-xs">{t("admin.users.active")}</span>
      ) : (
        <span className="text-muted-foreground font-mono text-xs">{t("admin.users.inactive")}</span>
      ),
  },
];
