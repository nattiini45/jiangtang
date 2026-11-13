import { Form, Link, useNavigation } from "react-router";
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
import { getFormFields, parseFieldForm, fieldFormErrors } from "~/lib/custom-fields/form.server";
import { modelFieldValues } from "~/lib/custom-fields/display.server";
import { FieldValues } from "~/components/fields/field-values";
import { unlinkCatalogModel } from "~/domains/catalog/catalog.library.server";
import { formatDate } from "~/i18n/format";
import { useLocale } from "~/i18n/use-t";
import {
  modelParts,
  partDetail,
  partModelOptions,
} from "~/domains/inventory/inventory.parts.queries.server";
import { addPartStock } from "~/domains/inventory/inventory.parts.mutations.server";
import { setModelPartFit } from "~/domains/catalog/catalog.parts.mutations.server";
import { ModelParts, PartModel, EditModelParts } from "~/components/inventory/parts";

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
  const actor = await requireUser(request);
  const detail = await getModelDetail(params.id);
  if (!detail) throw toErrorResponse(new NotFoundError(tr("err.model.notFound")));
  return {
    ...detail,
    parts: await modelParts(params.id),
    partDetail: await partDetail(params.id),
    partOptions: await partModelOptions(params.id),
    canUnlink: actor.role === "ADMIN",
    kinds: await listDeviceKinds(false, detail.model.kind.id),
    fields: await getFormFields("EQUIPMENT"),
    filledFields: await modelFieldValues(detail.model),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const form = await request.clone().formData();
  const intent = String(form.get("_action") ?? "");
  if (["addPartStock", "addPartFit", "removePartFit"].includes(intent)) {
    try {
      if (intent === "addPartStock") await addPartStock(actor, params.id, form.get("quantity"));
      else
        await setModelPartFit(actor, params.id, {
          partModelId: form.get("partModelId"),
          remove: intent === "removePartFit",
        });
      return { partsSaved: true };
    } catch (error) {
      if (error instanceof ValidationError)
        return {
          partsError: [...Object.values(error.fieldErrors).flat(), ...error.formErrors].join(" "),
        };
      if (error instanceof z.ZodError) return { partsError: tr("parts.invalid") };
      throw toErrorResponse(error);
    }
  }
  if (form.get("_action") === "unlinkCatalog") {
    try {
      await unlinkCatalogModel(actor, params.id);
      return { ok: true };
    } catch (error) {
      throw toErrorResponse(error);
    }
  }
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
    const detail = await getModelDetail(params.id);
    if (!detail) throw new NotFoundError();
    const customValues = await parseFieldForm(
      "EQUIPMENT",
      form,
      detail.model.customValues,
      result.data.kindId,
    );
    const model = await updateModel(actor, params.id, { ...result.data, customValues });
    await emitChange({ entityType: "equipmentModel", id: model.id, op: "updated" });
    return { fieldErrors: undefined, ok: true };
  } catch (e) {
    if (e instanceof ValidationError)
      return { fieldErrors: await fieldFormErrors("EQUIPMENT", e.fieldErrors), ok: false };
    throw toErrorResponse(e);
  }
}

export default function ModelDetail({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
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

      {loaderData.partDetail?.isPart ? (
        <PartModel modelId={model.id} detail={loaderData.partDetail} />
      ) : null}
      {loaderData.parts.length ? <ModelParts fits={loaderData.parts} /> : null}
      {!loaderData.partDetail?.isPart || instances.length ? (
        <ModelAssetView stats={stats} instances={instances} />
      ) : null}
      {loaderData.filledFields.length || model.catalogKey || model.manualUrl ? (
        <section className="bg-card shadow-surface-2 min-w-0 rounded-lg p-4">
          <h2 className="mb-3 text-base font-semibold">{t("fields.model.sheet")}</h2>
          {model.catalogKey ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm">
              {model.catalogSource ? (
                <p className="text-muted-foreground">
                  {t("inventory.catalog.source", {
                    manufacturer: model.catalogSource.manufacturer,
                    date: formatDate(locale, `${model.catalogSource.retrievedOn}T12:00:00Z`),
                  })}{" "}
                  <a
                    className="underline underline-offset-4"
                    href={model.catalogSource.productUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("inventory.catalog.productPage")}
                  </a>
                </p>
              ) : null}
              {loaderData.canUnlink ? (
                <Form
                  method="post"
                  onSubmit={(event) => {
                    if (!confirm(t("inventory.catalog.unlinkConfirm"))) event.preventDefault();
                  }}
                >
                  <Button
                    variant="ghost"
                    size="compact"
                    name="_action"
                    value="unlinkCatalog"
                    disabled={busy}
                  >
                    {t("inventory.catalog.unlink")}
                  </Button>
                </Form>
              ) : null}
            </div>
          ) : null}
          <FieldValues fields={loaderData.filledFields} showLegend={false} />
          {model.manualUrl ? (
            <a
              href={model.manualUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block text-sm underline underline-offset-4"
            >
              {t("inventory.catalog.manual")}
            </a>
          ) : null}
        </section>
      ) : null}

      <ModelPortsEditor ports={model.ports} />
      <EditModelParts modelId={model.id} fits={loaderData.parts} options={loaderData.partOptions} />

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
            fields={loaderData.fields}
            stored={model.customValues}
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
