import { useEffect, useRef } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { getOptionalUser, sanitizeNext } from "~/lib/auth.server";
import { completeTwoFactorSignIn } from "~/domains/auth/two-factor.server";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * Second sign-in step for an account with two-factor authentication. The
 * password step left a signed, short-lived challenge cookie; without it the
 * action can only send the visitor back to /login. Desktop and mobile sign-in
 * both pass through here, and `next` carries them back to where they started.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const next = sanitizeNext(url.searchParams.get("next"));
  const user = await getOptionalUser(request);
  if (user && user.isActive !== false) throw redirect(next);
  return { next, backup: url.searchParams.get("method") === "backup" };
}

export async function action({ request }: Route.ActionArgs) {
  const locale = resolveLocale(request);
  const form = await request.formData();
  const next = sanitizeNext(String(form.get("next") ?? "/"));
  const method = form.get("method") === "backup" ? "backup" : "totp";
  const code = String(form.get("code") ?? "")
    .trim()
    .slice(0, 32);
  if (!code) return { error: t(locale, "auth.twoFactor.invalidCode") };

  const result = await completeTwoFactorSignIn(request, { code, method });
  if (result.ok) {
    const headers = new Headers();
    for (const cookie of result.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return redirect(next, { headers });
  }
  if (result.reason === "expired") {
    throw redirect(`/login?twoFactorExpired=1&next=${encodeURIComponent(next)}`);
  }
  if (result.reason === "locked") {
    return data({ error: t(locale, "auth.twoFactor.locked") }, { status: 429 });
  }
  return { error: t(locale, "auth.twoFactor.invalidCode") };
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "auth.twoFactor.title") }];
}

export default function TwoFactorSignIn({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const { next, backup } = loaderData;
  const codeRef = useRef<HTMLInputElement>(null);
  const error = actionData && "error" in actionData ? actionData.error : undefined;

  // A wrong code clears the field so the next one can be typed straight away.
  useEffect(() => {
    if (!error || !codeRef.current) return;
    codeRef.current.value = "";
    codeRef.current.focus();
  }, [actionData, error]);

  const switchTo = `/login/two-factor?next=${encodeURIComponent(next)}${backup ? "" : "&method=backup"}`;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="bg-card text-card-foreground shadow-surface-3 w-full max-w-sm rounded-xl p-6">
        <h1 className="text-xl font-bold">{t("auth.twoFactor.heading")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {backup ? t("auth.twoFactor.introBackup") : t("auth.twoFactor.intro")}
        </p>

        {error ? (
          <p role="alert" className="bg-destructive/15 text-foreground mt-4 rounded-md p-2 text-sm">
            {error}
          </p>
        ) : null}

        <Form method="post" className="mt-4 flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="method" value={backup ? "backup" : "totp"} />
          <FormField
            name="code"
            label={backup ? t("auth.twoFactor.backupCode") : t("auth.twoFactor.code")}
          >
            <Input
              ref={codeRef}
              name="code"
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode={backup ? "text" : "numeric"}
              pattern={backup ? undefined : "[0-9]{6}"}
              maxLength={backup ? 32 : 6}
              spellCheck={false}
            />
          </FormField>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? t("auth.twoFactor.submitting") : t("auth.twoFactor.submit")}
          </Button>
        </Form>
        <div className="mt-4 flex flex-col items-center gap-2 text-xs">
          <Link
            to={switchTo}
            className="text-muted-foreground underline decoration-(--input) underline-offset-4"
          >
            {backup ? t("auth.twoFactor.useApp") : t("auth.twoFactor.useBackup")}
          </Link>
          <Link
            to={`/login?next=${encodeURIComponent(next)}`}
            className="text-muted-foreground underline decoration-(--input) underline-offset-4"
          >
            {t("auth.twoFactor.back")}
          </Link>
        </div>
      </div>
    </main>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
