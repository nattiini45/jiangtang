import { redirect } from "react-router";
import { authLanding } from "~/lib/view.server";
import type { Route } from "./+types/route";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { safeParseForm } from "~/lib/validation.server";
import { resolveInvite, acceptInvite } from "~/domains/auth/users.queries.server";
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
 * Public invite-acceptance page. This is the deliberate opt-out of
 * the `_desktop` auth guard: an unsigned invitee follows their magic link here
 * to set a password, which creates the account via Better Auth. The token
 * resolves to the role/initials the admin chose; the user is then redirected to
 * login. Tokens are single-use + 7-day TTL (users.queries.server).
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  // Resolve up front so an expired/invalid link shows a clear message rather
  // than a bare form that fails on submit.
  try {
    await resolveInvite(params.token!);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw toErrorResponse(e);
    // A bad/used token is a routine 404, not a server error. Carry the message
    // as the response body: RouteErrorBoundary only prints `data` when it is a
    // string, so toErrorResponse()'s JSON object body would show the generic
    // fallback text instead. Worded here, in the request language, rather than
    // taken from `e.message`.
    throw new Response(t(resolveLocale(request), "auth.invite.notFound"), { status: 404 });
  }
  return {
    token: params.token!,
    next: authLanding(request, new URL(request.url).searchParams.get("next")),
  };
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const result = await safeParseForm(request, acceptInviteSchema);
    if (!result.success) return { fieldErrors: result.fieldErrors };
    const invite = await resolveInvite(result.data.token);
    await acceptInvite(invite, result.data.password);
    const next = authLanding(request, result.data.next);
    return redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  } catch (e) {
    // An email or initials clash: nothing was created, so say why on the form.
    if (e instanceof ValidationError) {
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "auth.invite.title") }];
}

export default function AcceptInvite({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const fieldErrors =
    actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;
  const formErrors = actionData && "formErrors" in actionData ? actionData.formErrors : undefined;
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="bg-card text-card-foreground shadow-surface-3 w-full max-w-sm rounded-xl p-6">
        <h1 className="text-xl font-bold">{t("auth.invite.heading")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("auth.invite.intro")}</p>
        {formErrors?.length ? (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {formErrors.join(" ")}
          </p>
        ) : null}
        <ZodForm className="mt-4" fieldErrors={fieldErrors}>
          <input type="hidden" name="token" value={loaderData.token} />
          <input type="hidden" name="next" value={loaderData.next} />
          <FormField name="password" label={t("auth.invite.password")}>
            <Input name="password" type="password" required autoComplete="new-password" />
          </FormField>
          <FormField name="confirm" label={t("auth.invite.confirm")}>
            <Input name="confirm" type="password" required autoComplete="new-password" />
          </FormField>
          <Button type="submit" className="w-full">
            {t("auth.invite.submit")}
          </Button>
        </ZodForm>
      </div>
    </main>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
