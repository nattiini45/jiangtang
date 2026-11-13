import { db } from "~/lib/db.server";
import { propertyLibrary } from "~/lib/equipment-kinds/properties";
import parts from "~/lib/catalog/parts.json" with { type: "json" };
import { loadModelCatalog } from "~/lib/catalog/catalog.server";

export const availablePartStock = {
  equipmentId: null,
  quantity: { gt: 0 },
  OR: [{ status: null }, { status: "AVAILABLE" as const }],
};

export async function modelParts(modelId: string | null) {
  if (!modelId) return [];
  const fits = await db.modelPartFit.findMany({
    where: { modelId },
    include: {
      partModel: {
        include: {
          kind: true,
          stock: {
            where: availablePartStock,
            include: { location: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      },
    },
    orderBy: [{ partModel: { name: "asc" } }, { id: "asc" }],
  });
  return fits.map((fit) => ({
    id: fit.id,
    quantity: fit.quantity,
    sourceUrl: fit.sourceUrl,
    catalogKey: fit.catalogKey,
    part: {
      id: fit.partModel.id,
      name: fit.partModel.name,
      manufacturer: fit.partModel.manufacturer,
      kind: fit.partModel.kind?.name ?? null,
    },
    count: fit.partModel.stock.reduce((sum, row) => sum + row.quantity, 0),
    stock: fit.partModel.stock.map((row) => ({
      id: row.id,
      name: row.name,
      quantity: row.quantity,
      location: row.location?.name ?? null,
    })),
  }));
}

export async function partDetail(modelId: string) {
  const model = await db.equipmentModel.findUnique({
    where: { id: modelId },
    include: { kind: true },
  });
  if (!model) return null;
  const fits = await db.modelPartFit.findMany({
    where: { partModelId: modelId },
    include: {
      model: {
        include: {
          instances: { include: { room: true }, orderBy: [{ name: "asc" }, { id: "asc" }] },
        },
      },
    },
    orderBy: [{ model: { name: "asc" } }, { id: "asc" }],
  });
  const stock = await db.inventoryItem.findMany({
    where: { modelId, ...availablePartStock },
    select: { id: true, name: true, quantity: true, location: { select: { name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const compatibility: {
    id: string;
    modelId: string | null;
    name: string;
    manufacturer: string | null;
    sourceUrl: string | null;
    devices: {
      id: string;
      name: string | null;
      assetTag: string | null;
      status: string;
      room: { name: string; slug: string } | null;
    }[];
  }[] = fits.map((fit) => ({
    id: fit.id,
    modelId: fit.modelId,
    name: fit.model.name,
    manufacturer: fit.model.manufacturer,
    sourceUrl: fit.sourceUrl,
    devices: fit.model.instances.map((unit) => ({
      id: unit.id,
      name: unit.name,
      assetTag: unit.assetTag,
      status: unit.status,
      room: unit.room ? { name: unit.room.name, slug: unit.room.slug } : null,
    })),
  }));
  if (model.catalogKey) {
    const catalog = await loadModelCatalog();
    for (const fit of parts.fits.filter((fit) => fit.partKey === model.catalogKey)) {
      const record = catalog.records.find((record) => record.key === fit.modelKey)!;
      if (
        fits.some(
          (row) =>
            row.model.catalogKey === record.key ||
            (row.model.manufacturer?.trim().toLowerCase() === record.manufacturer.toLowerCase() &&
              row.model.name.trim().toLowerCase() === record.name.toLowerCase()),
        )
      )
        continue;
      compatibility.push({
        id: `catalog:${fit.modelKey}`,
        modelId: null,
        name: record.name,
        manufacturer: record.manufacturer,
        sourceUrl: fit.sourceUrl,
        devices: [],
      });
    }
  }
  compatibility.sort(
    (a, b) =>
      Number(b.devices.length > 0) - Number(a.devices.length > 0) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return {
    isPart: propertyLibrary.partKinds?.includes(model.kind?.systemKey ?? "") || fits.length > 0,
    count: stock.reduce((sum, row) => sum + row.quantity, 0),
    stock,
    fits: compatibility,
  };
}

export async function partModelOptions(except: string, currentId?: string | null) {
  return db.equipmentModel.findMany({
    where: {
      id: { not: except },
      OR: [
        ...(currentId ? [{ id: currentId }] : []),
        {
          kind: {
            archivedAt: null,
            group: { archivedAt: null },
            OR: [{ systemKey: { in: propertyLibrary.partKinds ?? [] } }, { systemKey: null }],
          },
        },
      ],
    },
    select: { id: true, name: true, manufacturer: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}
