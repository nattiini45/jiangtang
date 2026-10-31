import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { auth, getOptionalUser, sanitizeNext } from "~/lib/auth.server";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
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
  return { deactivated: user?.isActive === false || url.searchParams.has("deactivated"), next };
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
      <div className="border-border bg-card text-card-foreground w-full max-w-sm border p-6">
        <h1 className="font-mono text-xl">Jiangtang</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("auth.login.subtitle")}</p>

        {loaderData.deactivated ? (
          <p className="border-status-warning/40 bg-status-warning/10 text-status-warning mt-4 border p-2 text-sm">
            {t("auth.login.deactivated")}
          </p>
        ) : null}
        {actionData && "error" in actionData && actionData.error ? (
          <p className="border-destructive/40 bg-destructive/10 text-destructive mt-4 border p-2 text-sm">
            {actionData.error}
          </p>
        ) : null}

        <Form method="post" className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="next" value={loaderData.next} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("auth.login.email")}</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="border-input bg-background rounded-sm border px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("auth.login.password")}</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="border-input bg-background rounded-sm border px-3 py-2 font-mono text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="bg-primary text-primary-foreground rounded-sm px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {busy ? t("auth.login.submitting") : t("auth.login.submit")}
          </button>
        </Form>
      </div>
    </main>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
