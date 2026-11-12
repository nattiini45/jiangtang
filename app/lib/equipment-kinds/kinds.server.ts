import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditFn } from "~/lib/audit.server";
import { workspaceLocale } from "~/i18n/locale.server";
import { Prisma, type EquipmentCategory } from "~/generated/prisma/client";
import { NotFoundError } from "~/lib/errors.server";
import { DEFAULT_EQUIPMENT_KINDS, DEFAULT_FUNCTION_GROUPS } from "./defaults";

export async function initializeKindsInTx(tx: Tx, audit: AuditFn) {
  if (await tx.equipmentKindsInitialization.findUnique({ where: { id: "defaults" } })) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('equipment-kinds-defaults', 0))`;
  if (await tx.equipmentKindsInitialization.findUnique({ where: { id: "defaults" } })) return;
  const locale = workspaceLocale();
  for (const group of DEFAULT_FUNCTION_GROUPS) {
    const created = await tx.equipmentFunctionGroup.create({
      data: { systemKey: group.key, name: group[locale], position: group.position },
    });
    await audit({
      action: "EquipmentFunctionGroupCreated",
      entityType: "equipmentFunctionGroup",
      entityId: created.id,
    });
    for (const [category, kind] of Object.entries(DEFAULT_EQUIPMENT_KINDS)) {
      if (kind.group !== group.key) continue;
      const createdKind = await tx.equipmentKind.create({
        data: {
          systemKey: kind.key,
          name: kind[locale],
          groupId: created.id,
          position: Object.keys(DEFAULT_EQUIPMENT_KINDS).indexOf(category),
          tracksFrequency: category === "MICROPHONE",
        },
      });
      await audit({
        action: "EquipmentKindCreated",
        entityType: "equipmentKind",
        entityId: createdKind.id,
      });
    }
  }
  await tx.equipmentKindsInitialization.create({ data: { id: "defaults", locale } });
}

export function initializeEquipmentKinds() {
  return txWithAudit(null, initializeKindsInTx);
}

export type EquipmentKindInput = { kindId?: string; category?: EquipmentCategory };

export async function resolveEquipmentKind(
  tx: Tx,
  input: EquipmentKindInput,
  currentKindId?: string | null,
) {
  if (!input.kindId && currentKindId) {
    const current = await tx.equipmentKind.findUnique({ where: { id: currentKindId } });
    if (current && categoryForKind(current.systemKey) === input.category)
      return { kindId: current.id, category: input.category! };
  }
  if (!input.kindId && !input.category) throw new NotFoundError();
  const kind = await tx.equipmentKind.findUnique({
    where:
      input.kindId !== undefined
        ? { id: input.kindId }
        : { systemKey: DEFAULT_EQUIPMENT_KINDS[input.category!].key },
    select: { id: true, systemKey: true },
  });
  if (!kind) throw new NotFoundError();
  const category = categoryForKind(kind.systemKey);
  return { kindId: kind.id, category };
}

function categoryForKind(key: string | null): EquipmentCategory {
  return (Object.entries(DEFAULT_EQUIPMENT_KINDS).find(([, value]) => value.key === key)?.[0] ??
    "OTHER") as EquipmentCategory;
}

export function listDeviceKinds(includeArchived = false, currentKindId?: string) {
  return db.equipmentFunctionGroup.findMany({
    where: includeArchived
      ? {}
      : {
          OR: [
            { archivedAt: null },
            ...(currentKindId ? [{ kinds: { some: { id: currentKindId } } }] : []),
          ],
        },
    orderBy: [{ position: "asc" }, { name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      position: true,
      kinds: {
        where: includeArchived
          ? {}
          : {
              OR: [
                { archivedAt: null, group: { archivedAt: null } },
                ...(currentKindId ? [{ id: currentKindId }] : []),
              ],
            },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, systemKey: true },
      },
    },
  });
}

export const kindSelect = {
  id: true,
  name: true,
  systemKey: true,
  group: { select: { id: true, name: true, position: true } },
} satisfies Prisma.EquipmentKindSelect;
export async function equipmentKindFilter(kindId?: string) {
  if (!kindId) return {};
  const kind = await db.equipmentKind.findUnique({ where: { id: kindId } });
  const defaultKeys: string[] = Object.values(DEFAULT_EQUIPMENT_KINDS).map((kind) => kind.key);
  if (kind?.systemKey && defaultKeys.includes(kind.systemKey)) {
    const category = categoryForKind(kind.systemKey);
    return {
      OR: [
        { kindId: null, category },
        {
          category,
          kind: {
            systemKey: { in: defaultKeys },
          },
        },
      ],
    };
  }
  return {
    OR: [{ kindId }],
  };
}
export type EquipmentKindSummary = Prisma.EquipmentKindGetPayload<{ select: typeof kindSelect }>;

export async function withEquipmentKinds<
  T extends { category: EquipmentCategory; kind: EquipmentKindSummary | null },
>(rows: T[]): Promise<Array<Omit<T, "kind"> & { kind: EquipmentKindSummary }>> {
  const needsFallback = (row: T) =>
    !row.kind || (!!row.kind.systemKey && categoryForKind(row.kind.systemKey) !== row.category);
  const defaults = rows.some(needsFallback)
    ? await db.equipmentKind.findMany({
        where: {
          systemKey: { in: Object.values(DEFAULT_EQUIPMENT_KINDS).map((kind) => kind.key) },
        },
        select: kindSelect,
      })
    : [];
  return rows.map((row) => {
    const kind = needsFallback(row)
      ? defaults.find((kind) => kind.systemKey === DEFAULT_EQUIPMENT_KINDS[row.category].key)
      : row.kind;
    if (!kind) throw new NotFoundError();
    return { ...row, kind };
  });
}

export async function backfillEquipmentKinds() {
  const mapping = Prisma.join(
    Object.entries(DEFAULT_EQUIPMENT_KINDS).map(
      ([category, kind]) => Prisma.sql`(${category}, ${kind.key})`,
    ),
  );
  for (const name of ["Equipment", "EquipmentModel"]) {
    const table = Prisma.raw(`"${name}"`);
    let changed: number;
    do {
      changed = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('equipment-kinds-backfill', 0))`;
          return tx.$executeRaw`
          WITH batch AS (
            SELECT id FROM ${table} WHERE "kindId" IS NULL ORDER BY id LIMIT 500 FOR UPDATE
          ), mapping(category, key) AS (VALUES ${mapping})
          UPDATE ${table} AS target SET "kindId" = kind.id
          FROM batch, mapping, "EquipmentKind" AS kind
          WHERE target.id = batch.id AND target."kindId" IS NULL
            AND target.category::text = mapping.category AND kind."systemKey" = mapping.key`;
        },
        { timeout: 30_000 },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (changed === 500);
  }
}
