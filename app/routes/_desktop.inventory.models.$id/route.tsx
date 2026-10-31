import { Link, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { tr } from "~/i18n/request-locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { getModelDetail } from "~/domains/catalog/catalog.queries.server";
import { modelEditSchema } from "~/domains/catalog/catalog.schema";
import { updateModel } from "~/domains/catalog/catalog.mutations.server";
import { ZodForm } from "~/components/forms";
import { ModelFormFields } from "~/components/inventory/model-form-fields";
import { ModelAssetView } from "~/components/inventory/model-asset-view";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "inventory.meta.titled", {
        name: data?.model.name ?? t(locale, "inventory.meta.modelFallback"),
      }),
    },
  ];
}

export async function loader({ params }: Route.LoaderArgs) {
  const detail = await getModelDetail(params.id);
  if (!detail) throw toErrorResponse(new NotFoundError(tr("err.model.notFound")));
  return detail;
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, modelEditSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors, ok: false };
  try {
    const model = await updateModel(actor, params.id, result.data);
    await emitChange({ entityType: "equipmentModel", id: model.id, op: "updated" });
    return { fieldErrors: undefined, ok: true };
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors, ok: false };
    throw toErrorResponse(e);
  }
}

export default function ModelDetail({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { model, stats, instances } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">
          {model.manufacturer ? `${model.manufacturer} ` : ""}
          {model.name}
        </h1>
        <Link to="/inventory/models" className="text-muted-foreground text-sm hover:underline">
          {t("inventory.models.back")}
        </Link>
      </div>

      <ModelAssetView stats={stats} instances={instances} />

      <details className="border-border border p-3">
        <summary className="text-muted-foreground cursor-pointer text-xs uppercase tracking-wide">
          {t("inventory.models.editSummary")}
        </summary>
        {actionData?.ok ? (
          <p className="border-status-operational/40 bg-status-operational/10 text-status-operational mt-3 border p-2 text-sm">
            {t("inventory.models.saved")}
          </p>
        ) : null}
        <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-3">
          <ModelFormFields
            defaults={{
              manufacturer: model.manufacturer,
              name: model.name,
              category: model.category,
              specNotes: model.specNotes,
              manualUrl: model.manualUrl,
            }}
          />
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("inventory.models.submit")}
          </Button>
        </ZodForm>
      </details>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
