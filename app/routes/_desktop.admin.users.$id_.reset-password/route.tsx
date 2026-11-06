import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { findUser } from "~/domains/auth/users.queries.server";
import { createPasswordReset, passwordResetPath } from "~/domains/auth/password-reset.server";
import { ZodForm } from "~/components/forms";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * Admin issues a one-time password reset link for a user, handed over
 * out-of-band like an invitation link. The link is shown once, in the action
 * response, and never put in a URL of this page.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  const user = await findUser(params.id!);
  return { user: { id: user.id, name: user.name, email: user.email, isActive: user.isActive } };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  try {
    const token = await createPasswordReset(params.id!, {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      initials: actor.initials,
    });
    const url = new URL(request.url);
    return { link: `${url.protocol}//${url.host}${passwordResetPath(token)}` };
  } catch (e) {
    if (e instanceof ValidationError) return { formErrors: e.formErrors };
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.reset.meta") }];
}

export default function IssuePasswordReset({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { user } = loaderData;
  const link = actionData && "link" in actionData ? actionData.link : undefined;
  const formErrors = actionData && "formErrors" in actionData ? actionData.formErrors : undefined;
  return (
    <div className="max-w-lg">
      <h1 className="text-xl font-bold">{t("admin.reset.title")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        {t("admin.reset.subtitle", { user: user.name, email: user.email })}
      </p>
      <p className="text-muted-foreground mt-4 text-sm">{t("admin.reset.hint")}</p>
      {formErrors?.length ? (
        <p role="alert" className="text-destructive mt-4 text-sm">
          {formErrors.join(" ")}
        </p>
      ) : null}
      {link ? (
        <div className="bg-status-info/15 text-status-info mt-4 rounded-lg p-4 text-sm">
          <p className="font-semibold">{t("admin.reset.created")}</p>
          <code className="bg-card mt-2 block rounded-md p-2 font-mono text-xs break-all">
            {link}
          </code>
        </div>
      ) : null}
      <ZodForm className="mt-6">
        <Button type="submit" disabled={!user.isActive}>
          {link ? t("admin.reset.again") : t("admin.reset.submit")}
        </Button>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
