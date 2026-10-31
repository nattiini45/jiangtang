import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { modelCreateSchema } from "~/domains/catalog/catalog.schema";
import { createModel } from "~/domains/catalog/catalog.mutations.server";
import { ZodForm } from "~/components/forms";
import { ModelFormFields } from "~/components/inventory/model-form-fields";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "inventory.meta.modelNew") }];
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, modelCreateSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors };
  try {
    const model = await createModel(actor, result.data);
    await emitChange({ entityType: "equipmentModel", id: model.id, op: "created" });
    return redirect(`/inventory/models/${model.id}`);
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function NewModel({ actionData }: Route.ComponentProps) {
  const t = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="font-mono text-xl">{t("inventory.models.createTitle")}</h1>
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <ModelFormFields />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("inventory.models.createSubmit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/inventory/models">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
