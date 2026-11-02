import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { safeParseForm } from "~/lib/validation.server";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { tRich } from "~/i18n/rich";
import { useT } from "~/i18n/use-t";
import { resolveLocale } from "~/i18n/locale.server";
import { findUser } from "~/domains/auth/users.queries.server";
import { pseudonymizeUser } from "~/domains/auth/gdpr.server";
import { eraseUserSchema } from "~/domains/auth/users.schema";
import { ZodForm, FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

/**
 * GDPR erasure flow. The deliberate, admin-gated operation that runs
 * `pseudonymizeUser` — the only sanctioned path past the ActivityLog immutability
 * guard. Two-step (GET confirm → POST act) so an errant click can't erase someone.
 * The user's identifying data is scrubbed; historical attribution (initials) and
 * the operational tickets remain — "pseudonymization, not deletion."
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  return { user: await findUser(params.id!) };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  const locale = resolveLocale(request);
  try {
    const result = await safeParseForm(request, eraseUserSchema);
    if (!result.success) return { fieldErrors: result.fieldErrors };

    // typed confirmation — the admin must type the target's exact email.
    // Guards against an errant/automated POST triggering an irreversible erasure.
    const target = await findUser(params.id!);
    if (result.data.confirmEmail !== target.email) {
      throw new ValidationError({
        confirmEmail: [t(locale, "err.user.erase.emailMismatch")],
      });
    }

    await pseudonymizeUser(
      { id: actor.id, name: actor.name, email: actor.email, initials: actor.initials },
      params.id!,
    );
    return redirect("/admin/users");
  } catch (e) {
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.erase.meta") }];
}

export default function EraseUser({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const user = loaderData.user;
  const fieldErrors =
    actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-xl font-bold">{t("admin.erase.title")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t("admin.erase.subtitle")}</p>

      <div className="bg-status-fault/15 text-status-fault mt-4 rounded-lg p-4 text-sm">
        <p className="font-semibold">{t("admin.erase.irreversible")}</p>
        <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1">
          <li>
            {tRich(
              t,
              "admin.erase.identity",
              { user: <strong>{user.name}</strong> },
              { email: user.email },
            )}
          </li>
          <li>{t("admin.erase.history")}</li>
          <li>{t("admin.erase.tickets")}</li>
        </ul>
      </div>

      <ZodForm method="post" className="mt-6" fieldErrors={fieldErrors}>
        <FormField name="confirmEmail" label={t("admin.erase.confirmLabel", { email: user.email })}>
          <Input name="confirmEmail" autoComplete="off" required placeholder={user.email} />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" variant="destructive">
            {t("admin.erase.confirm")}
          </Button>
          <Button variant="secondary" asChild>
            <a href={`/admin/users/${user.id}`}>{t("common.cancel")}</a>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
