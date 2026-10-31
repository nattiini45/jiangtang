import * as React from "react";
import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
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
  const url = new URL(request.url);
  // The invite token from a successful create; surfaced as a one-time magic
  // link the admin shares out-of-band (no SMTP in v1).
  const invitedToken = url.searchParams.get("invited");
  const base = `${url.protocol}//${url.host}`;
  const inviteLink = invitedToken ? `${base}/accept-invite/${invitedToken}` : null;
  return { users, canManage: can(user, "user.manage"), inviteLink };
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
          <h1 className="font-mono text-xl">{t("admin.users.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("admin.users.subtitle")}</p>
        </div>
        <Button asChild>
          <Link to="/admin/users/new">{t("admin.users.invite")}</Link>
        </Button>
      </div>
      {loaderData.inviteLink ? (
        <div className="border-status-info/40 bg-status-info/10 text-status-info border p-3 text-sm">
          <p className="font-medium">{t("admin.users.invited.title")}</p>
          <p className="text-muted-foreground mt-1">{t("admin.users.invited.hint")}</p>
          <code className="bg-background mt-2 block break-all border p-2 font-mono text-xs">
            {loaderData.inviteLink}
          </code>
        </div>
      ) : null}
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
