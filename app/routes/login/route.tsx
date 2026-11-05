import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { auth, getOptionalUser, sanitizeNext } from "~/lib/auth.server";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const next = sanitizeNext(url.searchParams.get("next"));
  const user = await getOptionalUser(request);
  // A deactivated account keeps a valid session, so `requireUser` sends it here
  // with ?deactivated=1. Redirecting it straight back to `next` would ping-pong
  // between the two loaders (ERR_TOO_MANY_REDIRECTS); only active users leave.
  if (user && user.isActive !== false) throw redirect(next);
  return {
    deactivated: user?.isActive === false || url.searchParams.has("deactivated"),
    passwordReset: url.searchParams.has("reset"),
    next,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const invalidCredentials = t(resolveLocale(request), "auth.login.invalidCredentials");
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  // Re-sanitize on the way out: never trust the round-tripped form value.
  const next = sanitizeNext(String(form.get("next") ?? "/"));

  try {
    const response = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const setCookie = response.headers.get("set-cookie");
    // Better Auth answers invalid credentials with a 401 Response instead of
    // throwing, so the catch below never sees them. No session cookie means
    // there is nothing to redirect with either.
    if (!response.ok || !setCookie) {
      return { error: invalidCredentials };
    }
    const headers = new Headers();
    headers.append("set-cookie", setCookie);
    return redirect(next, { headers });
  } catch {
    return { error: invalidCredentials };
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "auth.login.title") }];
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="bg-card text-card-foreground shadow-surface-3 w-full max-w-sm rounded-xl p-6">
        <h1 className="text-xl font-bold">Jiangtang</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("auth.login.subtitle")}</p>

        {loaderData.deactivated ? (
          <p className="bg-status-warning/15 text-foreground mt-4 rounded-md p-2 text-sm">
            {t("auth.login.deactivated")}
          </p>
        ) : null}
        {loaderData.passwordReset && !loaderData.deactivated ? (
          <p
            role="status"
            className="bg-status-info/15 text-foreground mt-4 rounded-md p-2 text-sm"
          >
            {t("auth.login.passwordReset")}
          </p>
        ) : null}
        {actionData && "error" in actionData && actionData.error ? (
          <p className="bg-destructive/15 text-foreground mt-4 rounded-md p-2 text-sm">
            {actionData.error}
          </p>
        ) : null}

        <Form method="post" className="mt-4 flex flex-col gap-4">
          <input type="hidden" name="next" value={loaderData.next} />
          <FormField name="email" label={t("auth.login.email")}>
            <Input name="email" type="email" required autoComplete="email" />
          </FormField>
          <FormField name="password" label={t("auth.login.password")}>
            <Input name="password" type="password" required autoComplete="current-password" />
          </FormField>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? t("auth.login.submitting") : t("auth.login.submit")}
          </Button>
        </Form>
      </div>
    </main>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
