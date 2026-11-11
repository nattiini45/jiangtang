import { Form, Link, data, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { changeInvitation, listInvitations } from "~/domains/auth/users.queries.server";
import { invitationActionSchema } from "~/domains/auth/users.schema";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { DataGrid, type ColumnDef } from "~/components/data-grid";
import { InvitationLink } from "~/components/auth/invitation-link";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate, formatDateTime } from "~/i18n/format";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  try {
    return { invitations: await listInvitations() };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new Response(null, { status: 403 });
  try {
    const parsed = await safeParseForm(request, invitationActionSchema);
    if (!parsed.success) return { formErrors: parsed.formErrors, fieldErrors: parsed.fieldErrors };
    const token = await changeInvitation(parsed.data.id, parsed.data.intent, actor);
    return data(
      {
        link: token ? `${new URL(request.url).origin}/accept-invite/${token}` : null,
        changed: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ValidationError) return { formErrors: error.formErrors };
    throw toErrorResponse(error);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.invitations.meta") }];
}

export default function Invitations({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const busy = useNavigation().state !== "idle";
  type Row = (typeof loaderData.invitations)[number];
  const columns: ColumnDef<Row>[] = [
    {
      accessorKey: "email",
      header: t("admin.users.col.email"),
      size: 200,
      cell: ({ row }) => (
        <span className="truncate" title={row.original.email}>
          {row.original.email}
        </span>
      ),
    },
    {
      accessorKey: "name",
      header: t("admin.users.col.name"),
      size: 130,
      cell: ({ row }) => (
        <span className="truncate" title={row.original.name}>
          {row.original.name}
        </span>
      ),
    },
    {
      accessorKey: "role",
      header: t("admin.users.col.role"),
      size: 75,
      cell: ({ row }) => t(`auth.role.${row.original.role}`),
    },
    {
      accessorKey: "state",
      header: t("admin.users.col.status"),
      size: 240,
      cell: ({ row }) => {
        const invitation = row.original;
        const date = invitation.acceptedAt ?? invitation.revokedAt ?? invitation.expiresAt;
        return (
          <span title={formatDateTime(locale, date)} className="nums">
            {t(`admin.invitations.lifecycle.${invitation.state}`, {
              date: formatDate(locale, date),
            })}
          </span>
        );
      },
    },
    {
      id: "invitedBy",
      header: t("admin.invitations.by"),
      size: 110,
      cell: ({ row }) => (
        <span className="truncate" title={row.original.invitedBy?.email}>
          {row.original.invitedBy?.name || t("admin.invitations.unknown")}
        </span>
      ),
    },
    {
      id: "actions",
      header: t("admin.invitations.actions"),
      size: 230,
      cell: ({ row }) => (
        <Form method="post" className="flex gap-2">
          <input type="hidden" name="id" value={row.original.id} />
          {row.original.state === "pending" || row.original.state === "expired" ? (
            <Button
              type="submit"
              name="intent"
              value="reissue"
              variant="secondary"
              size="compact"
              disabled={busy}
            >
              {t("admin.invitations.reissue")}
            </Button>
          ) : null}
          {row.original.state === "pending" ? (
            <Button
              type="submit"
              name="intent"
              value="revoke"
              variant="destructive"
              size="compact"
              disabled={busy}
              onClick={(event) => {
                if (
                  !window.confirm(
                    t("admin.invitations.revokeConfirm", { email: row.original.email }),
                  )
                )
                  event.preventDefault();
              }}
            >
              {t("admin.invitations.revoke")}
            </Button>
          ) : null}
        </Form>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-4" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("admin.invitations.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("admin.invitations.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="ghost">
            <Link to="/admin/users">{t("admin.users.title")}</Link>
          </Button>
          <Button asChild>
            <Link to="/admin/users/new">{t("admin.users.invite")}</Link>
          </Button>
        </div>
      </div>
      {actionData && "link" in actionData && actionData.link ? (
        <InvitationLink key={actionData.link} link={actionData.link} />
      ) : null}
      {actionData && "formErrors" in actionData && actionData.formErrors?.length ? (
        <p role="alert" className="text-destructive text-sm">
          {actionData.formErrors.join(" ")}
        </p>
      ) : null}
      <p role="status" className="text-muted-foreground text-sm">
        {busy
          ? t("admin.invitations.saving")
          : actionData && "changed" in actionData
            ? t("admin.invitations.saved")
            : ""}
      </p>
      <DataGrid
        columns={columns}
        data={loaderData.invitations}
        getRowId={(row) => row.id}
        emptyMessage={t("admin.invitations.empty")}
        maxHeight={600}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
