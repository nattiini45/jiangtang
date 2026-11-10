import * as React from "react";
import { Link } from "react-router";
import type { Route } from "./+types/route";
import { adminTwoFactorRequired, requireRole } from "~/lib/auth.server";
import { can } from "~/lib/rbac.server";
import { listUsers } from "~/domains/auth/users.queries.server";
import { DataGrid } from "~/components/data-grid";
import { usersColumns } from "~/components/auth/users-columns";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

// Admin → user management. ADMIN-gated; the loader returns a list of
// users and whether the signed-in admin may still manage (self-protection: an
// admin cannot deactivate/demote themselves or the last active admin — enforced
// by assertCanChangeAdminStatus, called from both the edit action and erasure).
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireRole(request, "ADMIN");
  const users = await listUsers();
  return {
    users,
    canManage: can(user, "user.manage"),
    adminTwoFactorRequired: adminTwoFactorRequired(),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.users.meta") }];
}

export default function AdminUsersIndex({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const columns = React.useMemo(() => usersColumns(t), [t]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("admin.users.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("admin.users.subtitle")}</p>
          {loaderData.adminTwoFactorRequired ? (
            <p className="text-muted-foreground text-xs">{t("admin.users.twoFactorRequired")}</p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link to="/admin/invitations">{t("admin.invitations.title")}</Link>
          </Button>
          <Button asChild>
            <Link to="/admin/users/new">{t("admin.users.invite")}</Link>
          </Button>
        </div>
      </div>
      <DataGrid
        columns={columns}
        data={loaderData.users}
        getRowId={(u) => u.id}
        emptyMessage={t("admin.users.empty")}
        maxHeight={600}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
