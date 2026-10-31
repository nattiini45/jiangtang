import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { safeParseForm } from "~/lib/validation.server";
import { findUser, updateUser } from "~/domains/auth/users.queries.server";
import { editUserSchema } from "~/domains/auth/users.schema";
import { ZodForm, FormField } from "~/components/forms";
import { Select } from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  return { user: await findUser(params.id!) };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  try {
    const result = await safeParseForm(request, editUserSchema);
    if (!result.success) return { fieldErrors: result.fieldErrors };
    await updateUser(params.id!, result.data, {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      initials: actor.initials,
    });
    return redirect("/admin/users");
  } catch (e) {
    throw toErrorResponse(e);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.user.meta") }];
}

export default function EditUser({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const user = loaderData.user;
  const fieldErrors =
    actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined;
  return (
    <div className="max-w-lg">
      <h1 className="font-mono text-xl">{user.name}</h1>
      <p className="text-muted-foreground mt-1 font-mono text-sm">{user.email}</p>

      <ZodForm className="mt-6" fieldErrors={fieldErrors}>
        <FormField name="initials" label={t("admin.user.initials")}>
          <Input
            name="initials"
            defaultValue={user.initials ?? ""}
            required
            maxLength={6}
            className="uppercase"
          />
        </FormField>
        <FormField name="role" label={t("admin.user.role")}>
          <Select name="role" defaultValue={user.role}>
            <option value="MEMBER">{t("auth.role.MEMBER")}</option>
            <option value="ADMIN">{t("auth.role.ADMIN")}</option>
          </Select>
        </FormField>
        <FormField name="weeklyCapacityHours" label={t("admin.user.capacity")}>
          <Input
            name="weeklyCapacityHours"
            type="number"
            min={0}
            max={168}
            step={0.5}
            defaultValue={
              user.weeklyCapacityMinutes == null ? "" : String(user.weeklyCapacityMinutes / 60)
            }
            placeholder={t("admin.user.capacityPlaceholder")}
          />
        </FormField>
        <FormField name="isActive" label={t("admin.user.status")}>
          <Select name="isActive" defaultValue={String(user.isActive)}>
            <option value="true">{t("admin.user.statusActive")}</option>
            <option value="false">{t("admin.user.statusInactive")}</option>
          </Select>
        </FormField>
        <Button type="submit">{t("common.save")}</Button>
      </ZodForm>

      <div className="border-status-fault/40 mt-6 border p-3">
        <p className="text-sm font-medium">{t("admin.user.gdpr.title")}</p>
        <p className="text-muted-foreground mt-1 text-xs">{t("admin.user.gdpr.hint")}</p>
        <Button asChild variant="destructive" size="sm" className="mt-2">
          <a href={`/admin/users/${user.id}/erase`}>{t("admin.user.gdpr.erase")}</a>
        </Button>
      </div>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
