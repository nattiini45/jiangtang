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
    cell: ({ row }) => (
      <Link
        to={`/admin/users/${row.original.id}`}
        className="truncate hover:underline"
        title={row.original.name}
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "email",
    header: t("admin.users.col.email"),
    cell: ({ row }) => (
      <span className="truncate" title={row.original.email}>
        {row.original.email}
      </span>
    ),
  },
  {
    accessorKey: "emailVerified",
    meta: {
      sizing: "short",
      searchText: (row) => t(row.emailVerified ? "admin.users.verified" : "admin.users.unverified"),
    },
    header: t("admin.users.verification"),
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs">
        {t(row.original.emailVerified ? "admin.users.verified" : "admin.users.unverified")}
      </span>
    ),
  },
  {
    accessorKey: "initials",
    meta: { sizing: "short" },
    header: t("admin.users.col.initials"),
    cell: ({ row }) =>
      row.original.initials ? <MonoCell>{row.original.initials}</MonoCell> : dash,
  },
  {
    accessorKey: "role",
    meta: { sizing: "short", searchText: (row) => t(`auth.role.${row.role}`) },
    header: t("admin.users.col.role"),
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        <RoleText role={row.original.role} />
      </span>
    ),
  },
  {
    id: "isActive",
    meta: {
      sizing: "short",
      searchText: (row) => t(row.isActive ? "admin.users.active" : "admin.users.inactive"),
    },
    header: t("admin.users.col.status"),
    cell: ({ row }) =>
      row.original.isActive ? (
        <span className="text-status-operational text-xs">{t("admin.users.active")}</span>
      ) : (
        <span className="text-muted-foreground text-xs">{t("admin.users.inactive")}</span>
      ),
  },
  {
    id: "twoFactorEnabled",
    meta: {
      sizing: "short",
      searchText: (row) =>
        t(row.twoFactorEnabled ? "admin.users.twoFactorOn" : "admin.users.twoFactorOff"),
    },
    header: t("admin.users.col.twoFactor"),
    cell: ({ row }) =>
      row.original.twoFactorEnabled ? (
        <span className="text-status-operational text-xs">{t("admin.users.twoFactorOn")}</span>
      ) : (
        <span className="text-muted-foreground text-xs">{t("admin.users.twoFactorOff")}</span>
      ),
  },
];
