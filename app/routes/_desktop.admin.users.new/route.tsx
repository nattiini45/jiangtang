import * as React from "react";
import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { safeParseForm } from "~/lib/validation.server";
import { createInvite } from "~/domains/auth/users.queries.server";
import { inviteSchema } from "~/domains/auth/users.schema";
import { ZodForm, FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  return {};
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  try {
    const result = await safeParseForm(request, inviteSchema);
    if (!result.success) return { fieldErrors: result.fieldErrors };

    // Invite token is generated server-side; for this self-hosted internal tool
    // the admin hands the invitee the magic link out-of-band (e.g. in person).
    // The link is returned on the page rather than emailed (in-app only v1,
    // no SMTP dependency).
    const token = await createInvite(result.data, {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      initials: actor.initials,
    });
    return redirect(`/admin/users?invited=${encodeURIComponent(token)}`);
  } catch (e) {
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.invite.meta") }];
}

export default function InviteUser({ actionData }: Route.ComponentProps) {
  const t = useT();
  const fieldErrors =
    actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;
  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-bold">{t("admin.invite.title")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t("admin.invite.subtitle")}</p>
      <ZodForm className="mt-6" fieldErrors={fieldErrors}>
        <FormField name="email" label={t("admin.invite.email")}>
          <Input name="email" type="email" required autoComplete="email" />
        </FormField>
        <FormField name="name" label={t("admin.invite.name")}>
          <Input name="name" required />
        </FormField>
        <FormField
          name="initials"
          label={t("admin.invite.initials")}
          hint={t("admin.invite.initialsHint")}
        >
          <Input name="initials" required maxLength={6} />
        </FormField>
        <FormField name="role" label={t("admin.invite.role")}>
          <Select name="role" defaultValue="MEMBER">
            <option value="MEMBER">{t("auth.role.MEMBER")}</option>
            <option value="ADMIN">{t("auth.role.ADMIN")}</option>
          </Select>
        </FormField>
        <Button type="submit">{t("admin.invite.submit")}</Button>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
