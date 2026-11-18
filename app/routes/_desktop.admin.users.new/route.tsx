import * as React from "react";
import { data } from "react-router";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Check } from "lucide-react";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { safeParseForm } from "~/lib/validation.server";
import { createInvite, resolveInvite } from "~/domains/auth/users.queries.server";
import { accountMailReady, sendInviteEmail } from "~/domains/auth/account-mail.server";
import { inviteSchema } from "~/domains/auth/users.schema";
import { ZodForm, FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { InvitationLink } from "~/components/auth/invitation-link";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  return { emailReady: await accountMailReady() };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  try {
    const sendByEmail = (await request.clone().formData()).get("sendEmail") === "on";
    if (sendByEmail && request.headers.get("origin") !== new URL(request.url).origin) {
      throw new Response(null, { status: 403 });
    }
    const result = await safeParseForm(request, inviteSchema);
    if (!result.success) return { fieldErrors: result.fieldErrors };

    const token = await createInvite(result.data, {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      initials: actor.initials,
    });
    const sent = sendByEmail
      ? await resolveInvite(token)
          .then((invite) =>
            sendInviteEmail({ token, email: invite.email, expiresAt: invite.expiresAt, request }),
          )
          .catch(() => false)
      : null;
    return data(
      { link: `${new URL(request.url).origin}/accept-invite/${token}`, sent },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.invite.meta") }];
}

export default function InviteUser({ actionData, loaderData }: Route.ComponentProps) {
  const t = useT();
  const fieldErrors =
    actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;
  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-bold">{t("admin.invite.title")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t("admin.invite.subtitle")}</p>
      {actionData && "link" in actionData ? (
        <div className="mt-4">
          {actionData.sent !== null ? (
            <p className="mb-2 text-sm" role="status">
              {t(actionData.sent ? "admin.invite.mailQueued" : "admin.invite.mailUnavailable")}
            </p>
          ) : null}
          <InvitationLink key={actionData.link} link={actionData.link} />
        </div>
      ) : null}
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
        {loaderData.emailReady ? (
          <label className="flex min-h-control items-center gap-2 text-sm">
            <Checkbox
              name="sendEmail"
              value="on"
              defaultChecked
              className="grid size-5 shrink-0 place-items-center rounded border border-input data-checked:bg-selected"
            >
              <CheckboxIndicator>
                <Check aria-hidden className="size-4" />
              </CheckboxIndicator>
            </Checkbox>
            {t("admin.invite.sendEmail")}
          </label>
        ) : null}
        <Button type="submit">{t("admin.invite.submit")}</Button>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
