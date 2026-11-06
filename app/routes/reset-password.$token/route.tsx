import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { safeParseForm } from "~/lib/validation.server";
import { completePasswordReset, resolvePasswordReset } from "~/domains/auth/password-reset.server";
import { acceptInviteSchema } from "~/domains/auth/users.schema";
import { ZodForm, FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * Public page behind a one-time password reset link. Like invite acceptance it
 * opts out of the sign-in guard: the token is the credential. Setting the
 * password signs the account out everywhere, then the person signs in again.
 */
function notFound(request: Request): Response {
  // Worded in the request language as a plain string body, which
  // RouteErrorBoundary prints (see accept-invite.$token).
  return new Response(t(resolveLocale(request), "places.err.reset.notFound"), { status: 404 });
}

export async function loader({ params, request }: Route.LoaderArgs) {
  try {
    const reset = await resolvePasswordReset(params.token!);
    return { token: params.token!, email: reset.email };
  } catch (e) {
    if (e instanceof NotFoundError) throw notFound(request);
    throw toErrorResponse(e);
  }
}

export async function action({ request }: Route.ActionArgs) {
  try {
    // Same fields and password rules as accepting an invitation.
    const result = await safeParseForm(request, acceptInviteSchema);
    if (!result.success) return { fieldErrors: result.fieldErrors };
    await completePasswordReset(result.data.token, result.data.password);
    return redirect("/login?reset=1");
  } catch (e) {
    if (e instanceof NotFoundError) throw notFound(request);
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "auth.reset.title") }];
}

export default function ResetPassword({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const fieldErrors =
    actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="bg-card text-card-foreground shadow-surface-3 w-full max-w-sm rounded-xl p-6">
        <h1 className="text-xl font-bold">{t("auth.reset.heading")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("auth.reset.intro", { email: loaderData.email })}
        </p>
        <ZodForm className="mt-4" fieldErrors={fieldErrors}>
          <input type="hidden" name="token" value={loaderData.token} />
          <FormField name="password" label={t("auth.reset.password")}>
            <Input name="password" type="password" required autoComplete="new-password" />
          </FormField>
          <FormField name="confirm" label={t("auth.reset.confirm")}>
            <Input name="confirm" type="password" required autoComplete="new-password" />
          </FormField>
          <Button type="submit" className="w-full">
            {t("auth.reset.submit")}
          </Button>
        </ZodForm>
      </div>
    </main>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
