import { isAPIError } from "better-auth/api";
import { useEffect } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { auth, getOptionalUser, sanitizeNext } from "~/lib/auth.server";
import { landingPageEnabled } from "~/lib/landing.server";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";
import { purgeSignedInCaches } from "~/lib/pwa/purge-caches";

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
    twoFactorExpired: url.searchParams.has("twoFactorExpired"),
    next,
    landingPage: landingPageEnabled(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const locale = resolveLocale(request);
  const invalidCredentials = t(locale, "auth.login.invalidCredentials");
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  // Re-sanitize on the way out: never trust the round-tripped form value.
  const next = sanitizeNext(String(form.get("next") ?? "/"));
  const forwardedFor = request.headers.get("x-forwarded-for");

  try {
    const response = await auth.api.signInEmail({
      body: { email, password },
      // The failed-sign-in throttle (a Better Auth hook) keys on the client IP,
      // which only the proxy's X-Forwarded-For header carries. Nothing else of
      // the request is needed, so nothing else is passed on.
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : undefined,
      asResponse: true,
    });
    // Better Auth answers invalid credentials with a 401 Response instead of
    // throwing, so the catch below never sees them.
    if (!response.ok) return { error: invalidCredentials };
    const headers = new Headers();
    for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
    // An enrolled account gets a short-lived challenge cookie instead of a
    // session; the second step exchanges it for one.
    const body = (await response.json()) as { twoFactorRedirect?: boolean };
    if (body.twoFactorRedirect) {
      return redirect(`/login/two-factor?next=${encodeURIComponent(next)}`, { headers });
    }
    // No session cookie means there is nothing to redirect with.
    if (!headers.has("set-cookie")) return { error: invalidCredentials };
    return redirect(next, { headers });
  } catch (error) {
    if (isAPIError(error) && error.statusCode === 429) {
      const retryAfter = Number(new Headers(error.headers).get("retry-after"));
      const minutes = Math.max(1, Math.ceil((Number.isFinite(retryAfter) ? retryAfter : 0) / 60));
      return data(
        { error: t(locale, "auth.login.throttled", { minutes }) },
        { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfter) || 60) } },
      );
    }
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

  // Sign-out and every expired-session redirect land here, and a signed-in visit is redirected
  // away before this renders. The installed app caches signed-in pages by URL, so clear them or
  // the next person offline on this device would be served the previous person's pages.
  useEffect(() => {
    void purgeSignedInCaches();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="bg-card text-card-foreground shadow-surface-3 w-full max-w-sm rounded-xl p-6">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="bg-foreground text-background flex size-8 items-center justify-center rounded-md text-base font-bold"
          >
            J
          </span>
          <h1 className="text-xl font-bold">Jiangtang</h1>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">{t("auth.login.subtitle")}</p>
        <p className="text-muted-foreground mt-1 text-sm">{t("auth.login.tagline")}</p>

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
        {loaderData.twoFactorExpired ? (
          <p
            role="status"
            className="bg-status-warning/15 text-foreground mt-4 rounded-md p-2 text-sm"
          >
            {t("auth.login.twoFactorExpired")}
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
        {loaderData.landingPage ? (
          <Link
            to="/welcome"
            className="text-muted-foreground mt-4 block text-center text-xs underline decoration-(--input) underline-offset-4"
          >
            {t("auth.login.about")}
          </Link>
        ) : null}
      </div>
    </main>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
