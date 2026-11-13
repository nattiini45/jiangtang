import { Form, Link, redirect, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/route";
import { requireUser, requireRole } from "~/lib/auth.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import { unmigratedLegacyValues } from "~/lib/custom-fields/legacy.server";
import { clearLegacyEquipmentValue } from "~/domains/inventory/inventory.custom-values.server";
import { getFormFields, parseFieldForm, fieldFormErrors } from "~/lib/custom-fields/form.server";
import { withFieldValues } from "~/lib/custom-fields/display.server";
import { FieldValues } from "~/components/fields/field-values";
import { listDeviceKinds } from "~/lib/equipment-kinds/kinds.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { tr } from "~/i18n/request-locale.server";
import { resolveLocale } from "~/i18n/locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { listModels } from "~/domains/catalog/catalog.queries.server";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import {
  getEquipment,
  listSubstitutionTargets,
} from "~/domains/inventory/inventory.queries.server";
import { unitAvailability } from "~/domains/inventory/inventory.availability.server";
import { listAttachments } from "~/domains/attachments/attachments.queries.server";
import { ENTITY_TYPE, listEntityHistory } from "~/domains/tickets/tickets.history.server";
import { equipmentEditSchema } from "~/domains/inventory/inventory.schema";
import {
  retireEquipment,
  setSubstitution,
  updateEquipment,
} from "~/domains/inventory/inventory.mutations.server";
import { ZodForm } from "~/components/forms";
import {
  EquipmentFormFields,
  type EquipmentDefaults,
} from "~/components/inventory/equipment-form-fields";
import { SubstitutionControl } from "~/components/inventory/substitution-control";
import { FileUpload } from "~/components/upload/file-upload";
import { AttachmentGallery } from "~/components/upload/attachment-gallery";
import { ActivityFeed } from "~/components/history/activity-feed";
import { AvailabilityTimeline } from "~/components/inventory/availability-timeline";
import { AttachmentCategory } from "~/generated/prisma/enums";
import { StatusBadge } from "~/components/ui/status-badge";
import { Button } from "~/components/ui/button";
import { berlinDateInput } from "~/lib/format-date";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { QrCode } from "~/components/qr/qr-code";
import { qrSvg } from "~/lib/qr.server";
import { useT } from "~/i18n/use-t";
import { mutateEquipmentPort } from "~/domains/inventory/inventory.ports.mutations.server";
import { EquipmentPorts } from "~/components/inventory/ports-editor";
import { modelParts } from "~/domains/inventory/inventory.parts.queries.server";
import { takePartForDevice } from "~/domains/inventory/inventory.parts.mutations.server";
import { ModelParts } from "~/components/inventory/parts";
import { readingDevices } from "~/domains/readings/readings.queries.server";
import { DeviceReadings } from "~/components/inventory/readings";
import {
  connectEquipmentPorts,
  disconnectEquipmentPorts,
} from "~/domains/inventory/inventory.connections.mutations.server";

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "inventory.meta.titled", {
        name: data?.equipment.name ?? t(locale, "inventory.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const e = await getEquipment(params.id);
  if (!e) throw toErrorResponse(new NotFoundError(tr("err.equipment.notFound")));
  // For pooled units, fetch availability over the next 30 days (utilization view).
  const from = new Date();
  const to = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const availability =
    e.mobility === "POOLED"
      ? [
          {
            equipmentId: e.id,
            equipmentLabel: e.name ?? e.assetTag ?? tr("inventory.detail.poolFallback"),
            assetTag: e.assetTag,
            windows: await unitAvailability(params.id, from, to),
          },
        ]
      : [];
  const [models, rooms, targets, attachments, history, kinds] = await Promise.all([
    listModels({ includeValues: true }),
    listRooms(),
    listSubstitutionTargets(params.id),
    listAttachments({ equipmentId: params.id }),
    listEntityHistory(ENTITY_TYPE.equipment, params.id, 20),
    listDeviceKinds(false, e.kind.id),
  ]);
  // Decimal → string so the loader payload is JSON-serializable.
  const equipment = { ...e, frequencyMhz: e.frequencyMhz ? e.frequencyMhz.toString() : null };
  // The equipment QR encodes this page's absolute URL — scanning it on the
  // device label opens the unit's detail directly.
  const origin = new URL(request.url).origin;
  const qrHref = `${origin}/inventory/${params.id}`;
  const qr = await qrSvg(qrHref);
  return {
    equipment,
    readings: (await readingDevices({ id: e.id }))[0] ?? null,
    parts: await modelParts(e.modelId),
    fields: await getFormFields("EQUIPMENT"),
    filledFields: [
      ...(await withFieldValues("EQUIPMENT", [e]))[0].fields,
      ...unmigratedLegacyValues(await getFieldSchema("EQUIPMENT"), e, e.kind.id),
    ],
    canClearLegacy: user.role === "ADMIN",
    kinds,
    models,
    rooms,
    targets,
    attachments,
    history,
    availability,
    from,
    to,
    qr,
    qrHref,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "update");
  const id = params.id;
  if (intent === "takePart") {
    try {
      await takePartForDevice(actor, id, String(form.get("stockId") ?? ""));
      return { partTaken: true };
    } catch (error) {
      if (error instanceof ValidationError)
        return {
          partError: [...Object.values(error.fieldErrors).flat(), ...error.formErrors].join(" "),
        };
      if (error instanceof NotFoundError) return { partError: tr("parts.unavailable") };
      throw toErrorResponse(error);
    }
  }
  const portActions = {
    portAdd: "add",
    portUpdate: "update",
    portRemove: "remove",
    portInherit: "inherit",
  } as const;
  if (
    Object.hasOwn(portActions, intent) ||
    intent === "portConnect" ||
    intent === "portDisconnect"
  ) {
    try {
      if (intent === "portConnect") {
        await connectEquipmentPorts(actor, {
          ...JSON.parse(String(form.get("connection"))),
          equipmentId: id,
        });
      } else if (intent === "portDisconnect") {
        await disconnectEquipmentPorts(actor, id, String(form.get("connectionId") ?? ""));
      } else
        await mutateEquipmentPort(
          actor,
          id,
          portActions[intent as keyof typeof portActions],
          form.has("port") ? JSON.parse(String(form.get("port"))) : undefined,
          String(form.get("portId") ?? ""),
        );
      return { portsSaved: true };
    } catch (error) {
      if (error instanceof NotFoundError) return { portError: tr("ports.changed") };
      if (
        error instanceof z.ZodError &&
        error.issues.some((issue) => issue.message === "ports.positionFull")
      )
        return { portError: tr("ports.positionFull") };
      if (error instanceof ValidationError)
        return {
          portError: [...Object.values(error.fieldErrors).flat(), ...error.formErrors].join(" "),
        };
      if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError"))
        return { portError: tr("ports.invalid") };
      throw toErrorResponse(error);
    }
  }
  try {
    if (intent === "clearLegacy") {
      await requireRole(request, "ADMIN");
      await clearLegacyEquipmentValue(actor, id, String(form.get("column") ?? ""));
      return redirect(`/inventory/${id}`);
    }
    if (intent === "retire") {
      const eq = await retireEquipment(actor, id);
      await emitChange({ entityType: "equipment", id: eq.id, op: "updated" });
      return redirect(`/inventory/${id}`);
    }
    if (intent === "setSubstitution") {
      const eq = await setSubstitution(actor, {
        spareId: id,
        faultyId: String(form.get("faultyId") ?? ""),
      });
      await emitChange({ entityType: "equipment", id: eq.id, op: "updated" });
      return redirect(`/inventory/${id}`);
    }
    if (intent === "clearSubstitution") {
      const eq = await setSubstitution(actor, { spareId: id, clear: true });
      await emitChange({ entityType: "equipment", id: eq.id, op: "updated" });
      return redirect(`/inventory/${id}`);
    }
    const result = safeParse(equipmentEditSchema, formDataToObject(form), locale);
    if (!result.success) return { fieldErrors: result.fieldErrors };
    const current = await getEquipment(id);
    if (!current) throw new NotFoundError();
    const customValues = await parseFieldForm(
      "EQUIPMENT",
      form,
      current.customValues,
      result.data.kindId,
    );
    const eq = await updateEquipment(actor, id, { ...result.data, customValues });
    await emitChange({ entityType: "equipment", id: eq.id, op: "updated" });
    return redirect(`/inventory/${id}`);
  } catch (e) {
    if (e instanceof ValidationError)
      return { fieldErrors: await fieldFormErrors("EQUIPMENT", e.fieldErrors) };
    throw toErrorResponse(e);
  }
}

export default function EquipmentDetail({ loaderData, actionData }: Route.ComponentProps) {
  const {
    equipment: eq,
    models,
    rooms,
    targets,
    attachments,
    history,
    availability,
    from,
    to,
    qr,
    qrHref,
  } = loaderData;
  const t = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const title = eq.name ?? eq.model?.name ?? eq.kind.name;

  const defaults: EquipmentDefaults = {
    kindId: eq.kind.id,
    category: eq.category,
    modelId: eq.modelId,
    roomId: eq.roomId,
    mobility: eq.mobility,
    status: eq.status,
    name: eq.name,
    assetTag: eq.assetTag,
    serial: eq.serial,
    hostname: eq.hostname,
    ipAddress: eq.ipAddress,
    macAddress: eq.macAddress,
    dellServiceTag: eq.dellServiceTag,
    dellExpressTag: eq.dellExpressTag,
    micKind: eq.micKind,
    frequencyMhz: eq.frequencyMhz,
    band: eq.band,
    channelLabel: eq.channelLabel,
    lampType: eq.lampType,
    lastLampChangeAt: berlinDateInput(eq.lastLampChangeAt),
    color: eq.color,
    attributes: eq.attributes ? JSON.stringify(eq.attributes, null, 2) : "",
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">{title}</h1>
          <StatusBadge kind="equipment" value={eq.status} />
        </div>
        <Link to="/inventory" className="text-muted-foreground text-sm hover:underline">
          {t("inventory.detail.back")}
        </Link>
      </div>

      {loaderData.parts.length ? (
        <ModelParts fits={loaderData.parts} deviceId={eq.id} retired={eq.status === "RETIRED"} />
      ) : null}
      {(["model", "device"] as const).map((from) => {
        const fields = loaderData.filledFields.filter((field) => field.from === from);
        return fields.length || (from === "model" && eq.model?.manualUrl) ? (
          <section key={from} className="bg-card shadow-surface-2 min-w-0 rounded-lg p-4">
            <h2 className="mb-3 text-base font-semibold">
              {t(from === "model" ? "fields.model.from" : "fields.device.own")}
            </h2>
            <FieldValues
              showLegend={false}
              fields={fields}
              canClearLegacy={loaderData.canClearLegacy}
              essentialFirst={fields.some((field) => field.origin === "library")}
            />
            {from === "model" && eq.model?.manualUrl ? (
              <a
                href={eq.model.manualUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-block text-sm underline underline-offset-4"
              >
                {t("inventory.catalog.manual")}
              </a>
            ) : null}
          </section>
        ) : null;
      })}

      <EquipmentPorts
        equipmentId={eq.id}
        ports={eq.ports}
        hasModel={
          !!eq.model?.ports.some(
            (template) => !eq.ports.some((port) => port.label === template.label),
          )
        }
      />
      {loaderData.readings ? (
        <DeviceReadings
          device={loaderData.readings}
          action={`/inventory/${eq.id}/readings`}
          summary
        />
      ) : null}

      {eq.status !== "RETIRED" ? (
        <SubstitutionControl
          current={eq.substitutingFor}
          targets={targets}
          error={actionData?.fieldErrors?.faultyId?.[0]}
        />
      ) : null}

      <ZodForm method="post" fieldErrors={actionData?.fieldErrors}>
        <EquipmentFormFields
          key={eq.id}
          fields={loaderData.fields}
          stored={eq.customValues}
          kinds={loaderData.kinds}
          models={models}
          rooms={rooms}
          defaults={defaults}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("inventory.detail.submit")}
          </Button>
        </div>
      </ZodForm>

      <Form
        method="post"
        className="border-t pt-4"
        onSubmit={(e) => {
          if (!confirm(t("inventory.detail.confirmRetire", { title }))) e.preventDefault();
        }}
      >
        <input type="hidden" name="_action" value="retire" />
        <Button type="submit" variant="destructive" disabled={busy || eq.status === "RETIRED"}>
          {t("inventory.detail.retire")}
        </Button>
        <p className="text-muted-foreground mt-1 text-xs">{t("inventory.detail.retireHint")}</p>
      </Form>

      <section className="bg-card shadow-surface-2 flex flex-col gap-3 rounded-lg p-4">
        <h2 className="text-base font-semibold">{t("inventory.detail.photos")}</h2>
        <AttachmentGallery attachments={attachments} redirectTo={`/inventory/${eq.id}`} />
        <FileUpload
          target={{ equipmentId: eq.id }}
          categories={[AttachmentCategory.EQUIPMENT]}
          redirectTo={`/inventory/${eq.id}`}
        />
      </section>

      {eq.mobility === "POOLED" ? (
        <AvailabilityTimeline units={availability} from={from} to={to} />
      ) : null}

      <section className="bg-card shadow-surface-2 rounded-lg">
        <header className="flex min-h-12 items-center px-4 py-3">
          <h2 className="text-base font-semibold">{t("inventory.detail.history")}</h2>
        </header>
        <ActivityFeed entries={history} />
      </section>
      <QrCode svg={qr} href={qrHref} titleKey="qr.equipment.title" />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
