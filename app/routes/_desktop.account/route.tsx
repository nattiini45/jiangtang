import * as React from "react";
import { data } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { safeParseForm } from "~/lib/validation.server";
import { changeOwnPassword, changePasswordSchema } from "~/domains/auth/account.server";
import { ZodForm, FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { roleLabel } from "~/components/auth/labels";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  return {
    user: { name: user.name, email: user.email, initials: user.initials, role: user.role },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  try {
    const result = await safeParseForm(request, changePasswordSchema);
    if (!result.success) return { fieldErrors: result.fieldErrors, changed: false as const };
    const headers = await changeOwnPassword(user, request, result.data);
    // Forward Better Auth's new session cookie: the old session was revoked with
    // the others, and this browser stays signed in on the new one.
    // Each cookie stays its own Set-Cookie header (session token and, when set,
    // the remember-me and cookie-cache cookies).
    const responseHeaders = new Headers();
    for (const cookie of headers.getSetCookie()) responseHeaders.append("set-cookie", cookie);
    return data({ changed: true as const }, { headers: responseHeaders });
  } catch (e) {
    if (e instanceof ValidationError)
      return { fieldErrors: e.fieldErrors, changed: false as const };
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "account.meta") }];
}

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const { user } = loaderData;
  const fieldErrors =
    actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;
  const changed = actionData?.changed === true;
  const formRef = React.useRef<HTMLFormElement>(null);
  // Clear the password fields after each successful change.
  React.useEffect(() => {
    if (changed) formRef.current?.reset();
  }, [actionData, changed]);
  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-bold">{t("account.title")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t("account.subtitle")}</p>

      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("account.name")}</dt>
        <dd>{user.name}</dd>
        <dt className="text-muted-foreground">{t("account.email")}</dt>
        <dd>{user.email}</dd>
        <dt className="text-muted-foreground">{t("account.initials")}</dt>
        <dd>{user.initials ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("account.role")}</dt>
        <dd>{roleLabel(locale, user.role)}</dd>
      </dl>

      <h2 className="mt-8 text-base font-semibold">{t("account.password.heading")}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{t("account.password.intro")}</p>
      {changed ? (
        <p role="status" className="bg-status-info/15 text-status-info mt-4 rounded-lg p-3 text-sm">
          {t("account.password.changed")}
        </p>
      ) : null}
      <ZodForm ref={formRef} className="mt-4" fieldErrors={fieldErrors}>
        <FormField name="currentPassword" label={t("account.password.current")}>
          <Input name="currentPassword" type="password" required autoComplete="current-password" />
        </FormField>
        <FormField name="newPassword" label={t("account.password.new")}>
          <Input name="newPassword" type="password" required autoComplete="new-password" />
        </FormField>
        <FormField name="confirm" label={t("account.password.confirm")}>
          <Input name="confirm" type="password" required autoComplete="new-password" />
        </FormField>
        <Button type="submit">{t("account.password.submit")}</Button>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
