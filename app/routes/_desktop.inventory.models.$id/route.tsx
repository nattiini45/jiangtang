import { Link, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listDeviceKinds } from "~/lib/equipment-kinds/kinds.server";
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
import { setEquipmentModelPorts } from "~/domains/catalog/catalog.ports.mutations.server";
import { ModelPortsEditor } from "~/components/inventory/ports-editor";

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

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const detail = await getModelDetail(params.id);
  if (!detail) throw toErrorResponse(new NotFoundError(tr("err.model.notFound")));
  return { ...detail, kinds: await listDeviceKinds() };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const form = await request.clone().formData();
  if (form.get("_action") === "modelPorts") {
    try {
      await setEquipmentModelPorts(actor, params.id, JSON.parse(String(form.get("ports") ?? "[]")));
      return { portsSaved: true };
    } catch (error) {
      if (
        error instanceof z.ZodError &&
        error.issues.some((issue) => issue.message === "ports.duplicate")
      )
        return { portError: tr("ports.duplicate") };
      if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError"))
        return { portError: tr("ports.invalid") };
      throw toErrorResponse(error);
    }
  }
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
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-bold">
          {model.manufacturer ? `${model.manufacturer} ` : ""}
          {model.name}
        </h1>
        <Link to="/inventory/models" className="text-muted-foreground text-sm hover:underline">
          {t("inventory.models.back")}
        </Link>
      </div>

      <ModelAssetView stats={stats} instances={instances} />

      <ModelPortsEditor ports={model.ports} />

      <details className="bg-card shadow-surface-2 rounded-lg p-4">
        <summary className="cursor-pointer text-base font-semibold">
          {t("inventory.models.editSummary")}
        </summary>
        {actionData?.ok ? (
          <p className="bg-status-operational/15 text-foreground mt-3 rounded-lg px-4 py-3 text-sm">
            {t("inventory.models.saved")}
          </p>
        ) : null}
        <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-3">
          <ModelFormFields
            kinds={loaderData.kinds}
            defaults={{
              kindId: model.kind.id,
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
