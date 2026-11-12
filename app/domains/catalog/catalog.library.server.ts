import { isDeepStrictEqual } from "node:util";
import { Prisma } from "~/generated/prisma/client";
import type { Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { lockDefinitions } from "~/lib/custom-fields/definitions.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import { valueObject } from "~/lib/custom-fields/fields";
import { lockKindStructure, categoryForKind } from "~/lib/equipment-kinds/kinds.server";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import {
  copyModelPortsInTx,
  lockEquipmentPorts,
} from "~/domains/inventory/inventory.ports.mutations.server";
import {
  loadModelCatalog,
  type CatalogRecord,
  type ModelCatalog,
} from "~/lib/catalog/catalog.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { requirePermission } from "~/lib/rbac.server";
import { tr } from "~/i18n/request-locale.server";
import { applyModelValuesInTx } from "./catalog.values.server";

type Snapshot = {
  values: Record<string, unknown>;
  name: string | null;
  manualUrl: string | null;
  ports: CatalogRecord["ports"] | null;
};
const normalize = (value: string | null) => value?.trim().toLowerCase();
const portValues = (
  ports: { label: string; connector: string; direction: string; signal: string }[],
) =>
  ports.map(({ label, connector, direction, signal }) => ({ label, connector, direction, signal }));

async function lockCatalog(tx: Tx) {
  await lockDefinitions(tx);
  await lockKindStructure(tx);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('model-catalog', 0))`;
}

export async function applyCatalogModelInTx(
  tx: Tx,
  audit: AuditFn,
  record: CatalogRecord,
  version: number,
  modelId?: string,
) {
  await lockCatalog(tx);
  let model = modelId
    ? await tx.equipmentModel.findUnique({
        where: { id: modelId },
        include: { kind: true, ports: { orderBy: { position: "asc" } } },
      })
    : await tx.equipmentModel.findUnique({
        where: { catalogKey: record.key },
        include: { kind: true, ports: { orderBy: { position: "asc" } } },
      });
  if (modelId && !model) throw new NotFoundError();
  if (modelId) {
    const holder = await tx.equipmentModel.findUnique({
      where: { catalogKey: record.key },
      select: { id: true },
    });
    if (holder && holder.id !== modelId)
      throw new ValidationError({}, [tr("inventory.catalog.alreadyLinked")]);
  }
  if (!model) {
    const matches = (
      await tx.equipmentModel.findMany({
        include: { kind: true, ports: { orderBy: { position: "asc" } } },
      })
    ).filter(
      (entry) =>
        normalize(entry.manufacturer) === normalize(record.manufacturer) &&
        normalize(entry.name) === normalize(record.name) &&
        (entry.kind ? entry.kind.systemKey : DEFAULT_EQUIPMENT_KINDS[entry.category].key) ===
          record.kind,
    );
    if (matches.length > 1) throw new ValidationError({}, [tr("inventory.catalog.ambiguous")]);
    model = matches[0] ?? null;
  }
  if (!model) {
    const kind = await tx.equipmentKind.findUnique({
      where: { systemKey: record.kind },
      include: { group: true },
    });
    if (!kind || kind.archivedAt || kind.group.archivedAt)
      throw new ValidationError({}, [tr("inventory.catalog.kindRequired")]);
    model = await tx.equipmentModel.create({
      data: {
        manufacturer: record.manufacturer,
        name: record.name,
        kindId: kind.id,
        category: categoryForKind(record.kind),
      },
      include: { kind: true, ports: { orderBy: { position: "asc" } } },
    });
    await audit({
      action: "EquipmentModelCreated",
      entityType: "equipmentModel",
      entityId: model.id,
      data: { name: model.name },
    });
  }
  if (model.catalogKey && model.catalogKey !== record.key)
    throw new ValidationError({}, [tr("inventory.catalog.alreadyLinked")]);
  const kindKey = model.kind ? model.kind.systemKey : DEFAULT_EQUIPMENT_KINDS[model.category].key;
  if (kindKey !== record.kind)
    throw new ValidationError({}, [tr("inventory.catalog.kindMismatch")]);
  await tx.$queryRaw`SELECT id FROM "EquipmentModel" WHERE id = ${model.id} FOR UPDATE`;
  model = await tx.equipmentModel.findUniqueOrThrow({
    where: { id: model.id },
    include: { kind: true, ports: { orderBy: { position: "asc" } } },
  });
  if (model.catalogKey && (model.catalogVersion ?? 0) >= version)
    return { model, devices: [] as string[], changed: false };
  const previous = model.catalogSnapshot as Snapshot | null;
  const fields = (await getFieldSchema("EQUIPMENT", {}, tx)).filter(
    (field) => field.libraryKey && field.level === "MODEL",
  );
  const own = valueObject(model.customValues);
  const current: Record<string, unknown> = {};
  for (const field of fields) {
    const stored = own[field.id];
    current[field.libraryKey!] =
      field.type === "CHOICE"
        ? (field.options.find((option) => option.id === stored)?.systemKey ?? stored)
        : field.type === "MULTI_CHOICE" && Array.isArray(stored)
          ? stored.map((id) => field.options.find((option) => option.id === id)?.systemKey ?? id)
          : stored;
  }
  const snapshot: Snapshot = {
    values: {},
    name:
      previous?.name === model.name || (!previous && model.name === record.name)
        ? record.name
        : (previous?.name ?? null),
    manualUrl: previous?.manualUrl ?? null,
    ports: previous?.ports ?? null,
  };
  const patch: Record<string, unknown> = {};
  for (const key of new Set([
    ...Object.keys(record.values),
    ...Object.keys(previous?.values ?? {}),
  ])) {
    const field = fields.find((field) => field.libraryKey === key);
    if (!field || field.archivedAt) {
      if (previous && Object.hasOwn(previous.values, key))
        snapshot.values[key] = previous.values[key];
      continue;
    }
    const value = record.values[key];
    const had = previous && Object.hasOwn(previous.values, key);
    const empty =
      current[key] == null ||
      current[key] === "" ||
      (Array.isArray(current[key]) && current[key].length === 0);
    if ((had && isDeepStrictEqual(current[key], previous.values[key])) || (!had && empty)) {
      patch[key] = value ?? null;
      if (value !== undefined) snapshot.values[key] = value;
    } else if (had) snapshot.values[key] = previous.values[key];
  }
  if (Object.keys(patch).length) await applyModelValuesInTx(tx, model.id, patch);
  const writeManual = previous ? model.manualUrl === previous.manualUrl : !model.manualUrl;
  const manualUrl = writeManual ? record.manualUrl : model.manualUrl;
  if (writeManual) snapshot.manualUrl = record.manualUrl;
  const name = previous?.name && model.name === previous.name ? record.name : model.name;
  const ports = portValues(model.ports);
  if (
    (!previous && !ports.length) ||
    (previous?.ports && isDeepStrictEqual(ports, previous.ports))
  ) {
    await tx.equipmentModelPort.deleteMany({ where: { modelId: model.id } });
    await tx.equipmentModelPort.createMany({
      data: record.ports.map((port, position) => ({ ...port, modelId: model.id, position })),
    });
    snapshot.ports = record.ports;
  }
  const devices: string[] = [];
  for (const device of await tx.equipment.findMany({
    where: { modelId: model.id },
    orderBy: { id: "asc" },
    select: { id: true },
  })) {
    await lockEquipmentPorts(tx, device.id);
    if (await tx.equipmentPort.count({ where: { equipmentId: device.id } })) continue;
    const copies = await copyModelPortsInTx(tx, device.id, model.id);
    if (copies.length) {
      devices.push(device.id);
      await audit({
        action: "CatalogDevicePortsFilled",
        entityType: "equipment",
        entityId: device.id,
        data: { catalogKey: record.key },
      });
    }
  }
  const updated = await tx.equipmentModel.update({
    where: { id: model.id },
    data: {
      name,
      manualUrl,
      catalogKey: record.key,
      catalogVersion: version,
      catalogSnapshot: snapshot as Prisma.InputJsonObject,
    },
  });
  await audit({
    action: previous ? "CatalogModelCorrected" : "CatalogModelLinked",
    entityType: "equipmentModel",
    entityId: model.id,
    data: { catalogKey: record.key, version, name: updated.name },
  });
  return { model: updated, devices, changed: true };
}

export async function linkCatalogModel(actor: AuditActor, catalogKey: string, modelId?: string) {
  const catalog = await loadModelCatalog();
  const record = catalog.records.find((record) => record.key === catalogKey);
  if (!record) throw new NotFoundError();
  const result = await txWithAudit(
    actor,
    (tx, audit) => applyCatalogModelInTx(tx, audit, record, catalog.version, modelId),
    { timeout: 30000 },
  );
  if (result.changed) {
    await emitChange({ entityType: "equipmentModel", id: result.model.id, op: "updated" });
    for (const id of result.devices)
      await emitChange({ entityType: "equipment", id, op: "updated" });
  }
  return result.model;
}

export async function unlinkCatalogModel(actor: AuditActor, modelId: string) {
  await requirePermission(actor, "audit.view");
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockCatalog(tx);
    await tx.$queryRaw`SELECT id FROM "EquipmentModel" WHERE id = ${modelId} FOR UPDATE`;
    const model = await tx.equipmentModel.findUniqueOrThrow({
      where: { id: modelId },
      include: { ports: { orderBy: { position: "asc" } } },
    });
    if (!model.catalogKey) return model;
    const previous = model.catalogSnapshot as Snapshot;
    const fields = await getFieldSchema("EQUIPMENT", {}, tx);
    const values = valueObject(model.customValues);
    for (const field of fields) {
      if (!field.libraryKey || !Object.hasOwn(previous.values, field.libraryKey)) continue;
      const value = values[field.id];
      const canonical =
        field.type === "CHOICE"
          ? (field.options.find((option) => option.id === value)?.systemKey ?? value)
          : field.type === "MULTI_CHOICE" && Array.isArray(value)
            ? value.map((id) => field.options.find((option) => option.id === id)?.systemKey ?? id)
            : value;
      if (isDeepStrictEqual(canonical, previous.values[field.libraryKey])) delete values[field.id];
    }
    if (previous.ports && isDeepStrictEqual(portValues(model.ports), previous.ports))
      await tx.equipmentModelPort.deleteMany({ where: { modelId } });
    const updated = await tx.equipmentModel.update({
      where: { id: modelId },
      data: {
        catalogKey: null,
        catalogVersion: null,
        catalogSnapshot: Prisma.DbNull,
        customValues: values as Prisma.InputJsonObject,
        manualUrl: model.manualUrl === previous.manualUrl ? null : model.manualUrl,
      },
    });
    await audit({
      action: "CatalogModelUnlinked",
      entityType: "equipmentModel",
      entityId: modelId,
      data: { name: model.name, catalogKey: model.catalogKey },
    });
    return updated;
  });
  await emitChange({ entityType: "equipmentModel", id: modelId, op: "updated" });
  return result;
}

export async function reconcileModelCatalog(catalog: ModelCatalog | undefined = undefined) {
  catalog ??= await loadModelCatalog();
  const result = await txWithAudit(
    { name: "Jiangtang" },
    async (tx, audit) => {
      await lockCatalog(tx);
      const models = await tx.equipmentModel.findMany({ include: { kind: true } });
      const changed = [],
        devices = [];
      for (const model of models) {
        const matches = model.catalogKey
          ? catalog.records.filter((record) => record.key === model.catalogKey)
          : catalog.records.filter(
              (record) =>
                normalize(model.manufacturer) === normalize(record.manufacturer) &&
                normalize(model.name) === normalize(record.name) &&
                (model.kind
                  ? model.kind.systemKey
                  : DEFAULT_EQUIPMENT_KINDS[model.category].key) === record.kind,
            );
        if (matches.length !== 1) continue;
        const record = matches[0];
        const currentKind = model.kind
          ? model.kind.systemKey
          : DEFAULT_EQUIPMENT_KINDS[model.category].key;
        if (currentKind !== record.kind) continue;
        if (!model.catalogKey) {
          const holder = await tx.equipmentModel.findUnique({
            where: { catalogKey: record.key },
            select: { id: true },
          });
          const identities = models.filter(
            (entry) =>
              normalize(entry.manufacturer) === normalize(record.manufacturer) &&
              normalize(entry.name) === normalize(record.name) &&
              (entry.kind ? entry.kind.systemKey : DEFAULT_EQUIPMENT_KINDS[entry.category].key) ===
                record.kind,
          );
          if (holder || identities.length !== 1) continue;
        }
        const applied = await applyCatalogModelInTx(
          tx,
          audit,
          matches[0],
          catalog.version,
          model.id,
        );
        if (applied.changed) changed.push(model.id);
        devices.push(...applied.devices);
      }
      return { changed, devices };
    },
    { timeout: 60000 },
  );
  for (const id of result.changed)
    await emitChange({ entityType: "equipmentModel", id, op: "updated" });
  for (const id of result.devices) await emitChange({ entityType: "equipment", id, op: "updated" });
  return result;
}

export async function catalogSource(catalogKey: string | null) {
  const record = catalogKey
    ? (await loadModelCatalog()).records.find((record) => record.key === catalogKey)
    : null;
  return record
    ? {
        manufacturer: record.manufacturer,
        productUrl: record.productUrl,
        retrievedOn: (
          record.sources.find((source) => source.url === record.productUrl) ?? record.sources[0]
        ).retrievedOn,
      }
    : null;
}
