import { db } from "~/lib/db.server";
import { catalogSource } from "./catalog.library.server";
import { listModelCatalog } from "~/lib/catalog/catalog.server";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import {
  kindSelect,
  equipmentKindFilter,
  withEquipmentKinds,
  type EquipmentKindSummary,
} from "~/lib/equipment-kinds/kinds.server";
import type { EquipmentCategory, EquipmentStatus } from "~/generated/prisma/client";

/** Read-only queries for the EquipmentModel catalog. */

export async function catalogModelOptions(kindId: string | null, query: string) {
  const kind = kindId
    ? await db.equipmentKind.findUnique({ where: { id: kindId }, include: { group: true } })
    : null;
  if (!kind?.systemKey || kind.archivedAt || kind.group.archivedAt) return [];
  const installed = await db.equipmentModel.findMany({ include: { kind: true } });
  const normalize = (value: string | null) => value?.trim().toLowerCase();
  const records = await listModelCatalog({ query, kind: kind.systemKey });
  return records
    .filter(
      (record) =>
        !installed.some(
          (model) =>
            model.catalogKey === record.key ||
            ((model.kind ? model.kind.systemKey : DEFAULT_EQUIPMENT_KINDS[model.category].key) ===
              record.kind &&
              normalize(model.name) === normalize(record.name) &&
              normalize(model.manufacturer) === normalize(record.manufacturer)),
        ),
    )
    .slice(0, 30)
    .map((record) => ({
      id: `catalog:${record.key}`,
      name: record.name,
      manufacturer: record.manufacturer,
    }));
}

export interface ModelListRow {
  id: string;
  manufacturer: string | null;
  name: string;
  category: EquipmentCategory;
  kind: EquipmentKindSummary;
  instanceCount: number;
  faultyCount: number;
  customValues?: unknown;
}

export async function listModels(
  opts?: {
    category?: EquipmentCategory;
    kindId?: string;
    q?: string;
    includeValues?: boolean;
  },
  page: { offset?: number; limit?: number } = {},
): Promise<ModelListRow[]> {
  const models = await db.equipmentModel.findMany({
    skip: page.offset,
    take: page.limit,
    where: {
      category: opts?.kindId ? undefined : opts?.category,
      AND: await equipmentKindFilter(opts?.kindId),
      ...(opts?.q
        ? {
            OR: [
              { name: { contains: opts.q, mode: "insensitive" } },
              { manufacturer: { contains: opts.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ manufacturer: "asc" }, { name: "asc" }, { id: "asc" }],
    include: { kind: { select: kindSelect }, _count: { select: { instances: true } } },
  });

  // Faulty-instance counts per model ("which model fails most"), one grouped query.
  const faulty = await db.equipment.groupBy({
    by: ["modelId"],
    where: { status: "FAULTY", modelId: { not: null } },
    _count: true,
  });
  const faultyByModel = new Map(faulty.map((f) => [f.modelId, f._count]));

  return (await withEquipmentKinds(models)).map((m) => ({
    id: m.id,
    manufacturer: m.manufacturer,
    name: m.name,
    category: m.category,
    kind: m.kind,
    instanceCount: m._count.instances,
    faultyCount: faultyByModel.get(m.id) ?? 0,
    ...(opts?.includeValues ? { customValues: m.customValues } : {}),
  }));
}

export async function getModel(id: string) {
  const model = await db.equipmentModel.findUnique({
    where: { id },
    include: {
      kind: { select: kindSelect },
      ports: { orderBy: [{ position: "asc" }, { id: "asc" }] },
    },
  });
  if (!model) return null;
  const { catalogSnapshot: _snapshot, ...resolved } = (await withEquipmentKinds([model]))[0];
  return { ...resolved, catalogSource: await catalogSource(model.catalogKey) };
}

export interface ModelStats {
  total: number;
  operational: number;
  faulty: number;
  maintenance: number;
  retired: number;
  openTickets: number;
}

export interface ModelInstanceRow {
  id: string;
  name: string | null;
  status: EquipmentStatus;
  assetTag: string | null;
  roomName: string | null;
  roomSlug: string | null;
}

/** Model + its failure stats + instance list (the by-model asset view). */
export async function getModelDetail(id: string) {
  const model = await getModel(id);
  if (!model) return null;

  const instances = await db.equipment.findMany({
    where: { modelId: id },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { room: { select: { name: true, slug: true } } },
  });

  const counts = { OPERATIONAL: 0, FAULTY: 0, MAINTENANCE: 0, RETIRED: 0 } as Record<
    EquipmentStatus,
    number
  >;
  for (const e of instances) counts[e.status]++;

  const openTickets = await db.ticket.count({
    where: { equipment: { modelId: id }, status: { in: ["OPEN", "IN_PROGRESS"] } },
  });

  const stats: ModelStats = {
    total: instances.length,
    operational: counts.OPERATIONAL,
    faulty: counts.FAULTY,
    maintenance: counts.MAINTENANCE,
    retired: counts.RETIRED,
    openTickets,
  };

  const instanceRows: ModelInstanceRow[] = instances.map((e) => ({
    id: e.id,
    name: e.name,
    status: e.status,
    assetTag: e.assetTag,
    roomName: e.room?.name ?? null,
    roomSlug: e.room?.slug ?? null,
  }));

  return { model, stats, instances: instanceRows };
}

/**
 * Does a model with this (manufacturer, name) already exist? The DB unique index
 * treats NULL manufacturers as distinct, so we check at the app layer too (review:
 * the catalog's whole point is reuse, so a soft dedup beats a silent duplicate).
 */
export async function modelExists(
  manufacturer: string | null | undefined,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const found = await db.equipmentModel.findFirst({
    where: {
      manufacturer: manufacturer ?? null,
      name,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return found !== null;
}
