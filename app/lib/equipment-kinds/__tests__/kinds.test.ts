import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { db, type Tx } from "~/lib/db.server";
import { writeActivity } from "~/lib/audit.server";
import { EquipmentCategory } from "~/generated/prisma/client";
import { t } from "~/i18n";
import {
  createEquipment,
  updateEquipment,
  bulkCreateEquipment,
} from "~/domains/inventory/inventory.mutations.server";
import { equipmentCsvRowSchema } from "~/domains/inventory/inventory.schema";
import { getEquipment, listEquipment } from "~/domains/inventory/inventory.queries.server";
import { createModel, updateModel } from "~/domains/catalog/catalog.mutations.server";
import { getModel, listModels } from "~/domains/catalog/catalog.queries.server";
import { equipmentCreateSchema } from "~/domains/inventory/inventory.schema";
import { modelCreateSchema } from "~/domains/catalog/catalog.schema";
import { loadSource } from "~/lib/search/sources.server";
import { reindexSource, reconcileAll } from "~/lib/search/indexer.server";
import { searchWorkspace } from "~/domains/search/search.queries.server";
import { cloneRoom } from "~/domains/rooms/rooms.mutations.server";
import { registerPlaceWrites } from "~/lib/mcp/place-writes.server";
import { registerReadTools } from "~/lib/mcp/read-tools.server";
import { DEMO_USER, EQUIPMENT, EQUIPMENT_MODELS } from "../../../../scripts/seed/data";
import { DEFAULT_EQUIPMENT_KINDS, DEFAULT_FUNCTION_GROUPS } from "../defaults";
import {
  backfillEquipmentKinds,
  initializeEquipmentKinds,
  initializeKindsInTx,
  listDeviceKinds,
} from "../kinds.server";

const run = `kinds_${randomUUID()}`;
const actor = { name: "Synthetic kind tester" };
const groupId = `${run}_group`;
const kindId = `${run}_kind`;

beforeAll(async () => {
  await initializeEquipmentKinds();
  await db.equipmentFunctionGroup.create({ data: { id: groupId, name: groupId, position: 99 } });
  await db.equipmentKind.create({ data: { id: kindId, name: kindId, groupId, position: 99 } });
});

afterAll(async () => {
  await db.chunk.deleteMany({ where: { sourceId: { startsWith: run } } });
  await db.equipment.deleteMany({
    where: { OR: [{ name: { startsWith: run } }, { id: { startsWith: run } }] },
  });
  await db.equipmentModel.deleteMany({ where: { name: { startsWith: run } } });
  await db.room.deleteMany({ where: { name: { startsWith: run } } });
  await db.campus.deleteMany({ where: { id: run } });
  await db.equipmentKind.deleteMany({ where: { id: { startsWith: run } } });
  await db.equipmentFunctionGroup.deleteMany({ where: { id: { startsWith: run } } });
  vi.unstubAllEnvs();
  await db.$disconnect();
});

async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  const rollback = new Error("rollback synthetic fixture");
  await expect(
    db.$transaction(
      async (tx) => {
        await fn(tx);
        throw rollback;
      },
      { timeout: 30_000 },
    ),
  ).rejects.toBe(rollback);
}

describe("equipment kind database invariants", () => {
  it("has the named checks, active-name indexes, required group and RESTRICT references", async () => {
    const constraints = await db.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
      SELECT conname, confdeltype::text FROM pg_constraint WHERE conname IN
      ('equipment_kind_name', 'equipment_function_group_name', 'EquipmentKind_groupId_fkey', 'Equipment_kindId_fkey', 'EquipmentModel_kindId_fkey')`;
    expect(constraints).toHaveLength(5);
    expect(
      constraints
        .filter((row) => row.conname.endsWith("fkey"))
        .every((row) => row.confdeltype === "r"),
    ).toBe(true);
    const indexes = await db.$queryRaw<
      Array<{ indexdef: string }>
    >`SELECT indexdef FROM pg_indexes WHERE indexname IN ('equipment_kind_active_name', 'equipment_function_group_active_name')`;
    expect(indexes).toHaveLength(2);
    for (const index of indexes)
      expect(index.indexdef).toMatch(/UNIQUE.*lower\(name\).*WHERE \("archivedAt" IS NULL\)/);
    await expect(
      db.$executeRaw`INSERT INTO "EquipmentKind" (id, name, position, "updatedAt") VALUES (${run}, 'Synthetic', 0, now())`,
    ).rejects.toThrow();
    await expect(
      db.equipmentKind.create({
        data: { name: `${run}_missing`, groupId: "missing", position: 0 },
      }),
    ).rejects.toThrow();
    await expect(db.equipmentFunctionGroup.delete({ where: { id: groupId } })).rejects.toThrow();
    await expect(
      db.equipmentKind.create({
        data: { name: `${run}_duplicateKey`, groupId, position: 0, systemKey: "projector" },
      }),
    ).rejects.toThrow();
    await expect(
      db.equipmentFunctionGroup.create({
        data: { name: `${run}_duplicateKey`, position: 0, systemKey: "display" },
      }),
    ).rejects.toThrow();
  });

  it("rejects blank/long names and case-insensitive active duplicates, but permits archived duplicates", async () => {
    for (const name of [" ", "x".repeat(61)]) {
      await expect(
        db.equipmentKind.create({ data: { name, groupId, position: 0 } }),
      ).rejects.toThrow();
      await expect(
        db.equipmentFunctionGroup.create({ data: { name, position: 0 } }),
      ).rejects.toThrow();
    }
    await expect(
      db.equipmentKind.create({ data: { name: kindId.toUpperCase(), groupId, position: 0 } }),
    ).rejects.toThrow();
    await expect(
      db.equipmentFunctionGroup.create({ data: { name: groupId.toUpperCase(), position: 0 } }),
    ).rejects.toThrow();
    await rolledBack(async (tx) => {
      await tx.equipmentKind.create({
        data: { name: kindId.toUpperCase(), groupId, position: 0, archivedAt: new Date() },
      });
      await tx.equipmentFunctionGroup.create({
        data: { name: groupId.toUpperCase(), position: 0, archivedAt: new Date() },
      });
    });
    const data = { name: `${run}_restrict`, category: "OTHER" as const, kindId };
    const eq = await db.equipment.create({ data });
    await expect(db.equipmentKind.delete({ where: { id: kindId } })).rejects.toThrow();
    await db.equipment.delete({ where: { id: eq.id } });
    const model = await db.equipmentModel.create({ data });
    await expect(db.equipmentKind.delete({ where: { id: kindId } })).rejects.toThrow();
    await db.equipmentModel.delete({ where: { id: model.id } });
  });

  it.each(["de", "en"] as const)(
    "initializes exactly seven groups and ten kinds once in %s",
    async (locale) => {
      vi.stubEnv("DEFAULT_LOCALE", locale);
      try {
        await rolledBack(async (tx) => {
          await tx.equipment.updateMany({ data: { kindId: null } });
          await tx.equipmentModel.updateMany({ data: { kindId: null } });
          await tx.equipmentKind.deleteMany();
          await tx.equipmentFunctionGroup.deleteMany();
          await tx.equipmentKindsInitialization.deleteMany();
          const audit = (input: Parameters<typeof writeActivity>[1]) => writeActivity(tx, input);
          await initializeKindsInTx(tx, audit);
          const groups = await tx.equipmentFunctionGroup.findMany({ orderBy: { position: "asc" } });
          const kinds = await tx.equipmentKind.findMany({
            orderBy: { position: "asc" },
            include: { group: true },
          });
          expect(groups.map((row) => [row.systemKey, row.name, row.position])).toEqual(
            DEFAULT_FUNCTION_GROUPS.map((row) => [row.key, row[locale], row.position]),
          );
          expect(kinds).toHaveLength(10);
          for (const [category, kind] of Object.entries(DEFAULT_EQUIPMENT_KINDS)) {
            expect(kind[locale]).toBe(
              t(locale, `search.equipmentCategory.${category as EquipmentCategory}`),
            );
            expect(kinds.find((row) => row.systemKey === kind.key)).toMatchObject({
              name: kind[locale],
              tracksFrequency: category === "MICROPHONE",
              group: { systemKey: kind.group },
            });
          }
          vi.stubEnv("DEFAULT_LOCALE", locale === "de" ? "en" : "de");
          await initializeKindsInTx(tx, audit);
          expect(
            await tx.equipmentKind.findMany({
              orderBy: { position: "asc" },
              include: { group: true },
            }),
          ).toEqual(kinds);
          expect(
            await tx.equipmentFunctionGroup.findMany({ orderBy: { position: "asc" } }),
          ).toEqual(groups);
          expect(
            await tx.equipmentKindsInitialization.findUnique({ where: { id: "defaults" } }),
          ).toEqual({ id: "defaults", locale });
          expect(
            await tx.activityLog.count({
              where: { entityId: { in: [...groups, ...kinds].map((row) => row.id) } },
            }),
          ).toBe(17);
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("backfills more than a batch in both tables, only NULLs, without changing timestamps or auditing", async () => {
    const categories = [
      ...Array(61).fill("MICROPHONE"),
      ...Array(58).fill("PROJECTOR"),
      ...Array(52).fill("REMOTE"),
      ...Array(41).fill("PC"),
      ...Array(290).fill("OTHER"),
    ] as EquipmentCategory[];
    const rows = categories.map((category, i) => ({
      id: `${run}_${i}`,
      name: `${run}_${i}`,
      category,
    }));
    await db.equipment.createMany({ data: rows });
    await db.equipmentModel.createMany({ data: rows });
    await db.equipment.update({ where: { id: rows[0].id }, data: { kindId } });
    await db.equipmentModel.update({ where: { id: rows[0].id }, data: { kindId } });
    const before = await db.equipment.findUniqueOrThrow({ where: { id: rows[1].id } });
    const auditCount = await db.activityLog.count();
    await backfillEquipmentKinds();
    await backfillEquipmentKinds();
    const where = { id: { in: rows.map((row) => row.id) } };
    for (const filled of [
      await db.equipment.findMany({ where, include: { kind: true } }),
      await db.equipmentModel.findMany({ where, include: { kind: true } }),
    ]) {
      expect(filled).toHaveLength(502);
      for (const row of filled)
        expect(row.kindId).toBe(row.id === rows[0].id ? kindId : row.kind?.id);
      expect(filled.filter((row) => !row.kindId)).toHaveLength(0);
      for (const row of filled.filter((row) => row.id !== rows[0].id))
        expect(row.kind?.systemKey).toBe(DEFAULT_EQUIPMENT_KINDS[row.category].key);
    }
    expect(await db.activityLog.count()).toBe(auditCount);
    expect((await db.equipment.findUniqueOrThrow({ where: { id: rows[1].id } })).updatedAt).toEqual(
      before.updatedAt,
    );
    await db.equipment.deleteMany({ where });
    await db.equipmentModel.deleteMany({ where });
  });
});

describe("kind-aware domain and MCP boundaries", () => {
  it("lists active kinds under ordered groups and includes archived entries only on request", async () => {
    await db.equipmentKind.create({
      data: {
        id: `${run}_archived`,
        name: `${run}_archived`,
        groupId,
        position: 1,
        archivedAt: new Date("2040-01-01T00:00:00Z"),
      },
    });
    await db.equipmentFunctionGroup.create({
      data: {
        id: `${run}_archived_group`,
        name: `${run}_archived_group`,
        position: 0,
        archivedAt: new Date("2040-01-01T00:00:00Z"),
      },
    });
    const active = await listDeviceKinds();
    expect(active.map((group) => group.position)).toEqual(
      active.map((group) => group.position).sort((a, b) => a - b),
    );
    expect(active.find((group) => group.id === groupId)?.kinds.map((kind) => kind.id)).toEqual([
      kindId,
    ]);
    expect(active.some((group) => group.id === `${run}_archived_group`)).toBe(false);
    const all = await listDeviceKinds(true);
    expect(all.some((group) => group.id === `${run}_archived_group`)).toBe(true);
    expect(all.find((group) => group.id === groupId)?.kinds.map((kind) => kind.id)).toContain(
      `${run}_archived`,
    );
  });

  it("accepts kind-only forms and preserves custom kinds for matching category-only updates", async () => {
    expect(equipmentCreateSchema.parse({ kindId, mobility: "POOLED" })).toMatchObject({ kindId });
    expect(modelCreateSchema.parse({ kindId, name: run })).toMatchObject({ kindId });
    expect(equipmentCreateSchema.safeParse({ mobility: "POOLED" }).success).toBe(false);
    expect(modelCreateSchema.safeParse({ name: run }).success).toBe(false);
    const equipment = await createEquipment(actor, {
      kindId,
      name: `${run}_preserve`,
      mobility: "POOLED",
      status: "OPERATIONAL",
    });
    const model = await createModel(actor, { kindId, name: `${run}_preserve` });
    expect(
      await updateEquipment(actor, equipment.id, {
        category: "OTHER",
        name: equipment.name!,
        mobility: "POOLED",
        status: "OPERATIONAL",
      }),
    ).toMatchObject({ kindId });
    expect(
      await updateModel(actor, model.id, { category: "OTHER", name: model.name }),
    ).toMatchObject({ kindId });
    expect(await listEquipment({ kindId, category: "PC", q: `${run}_preserve` })).toHaveLength(1);
    expect(await listModels({ kindId, category: "PC", q: `${run}_preserve` })).toHaveLength(1);
    expect(
      await updateEquipment(actor, equipment.id, {
        category: "PC",
        name: equipment.name!,
        mobility: "POOLED",
        status: "OPERATIONAL",
      }),
    ).not.toMatchObject({ kindId });
    expect(
      await updateModel(actor, model.id, { category: "PC", name: model.name }),
    ).not.toMatchObject({ kindId });
  });

  it("refreshes already indexed devices with their kind and function group", async () => {
    const equipment = await db.equipment.create({
      data: { id: `${run}_search`, category: "OTHER", kindId },
    });
    const source = await loadSource("EQUIPMENT", equipment.id);
    expect(JSON.stringify(source)).toContain(kindId);
    expect(JSON.stringify(source)).toContain(groupId);
    await reindexSource("EQUIPMENT", equipment.id);
    await db.chunk.updateMany({
      where: { sourceId: equipment.id },
      data: { text: "old index text" },
    });
    await reconcileAll({ refreshTypes: ["EQUIPMENT"] });
    const chunks = await db.chunk.findMany({ where: { sourceId: equipment.id } });
    expect(
      chunks.some((chunk) => chunk.text.includes(kindId) && chunk.text.includes(groupId)),
    ).toBe(true);
    for (const q of [kindId, groupId]) {
      expect((await searchWorkspace(q, { sourceTypes: ["EQUIPMENT"] })).results).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceId: equipment.id })]),
      );
    }
  });

  it("writes matching kinds for every category, derives categories for kinds, and falls back on reads", async () => {
    await expect(
      createEquipment(actor, { kindId: "missing", mobility: "POOLED", status: "OPERATIONAL" }),
    ).rejects.toThrow();
    for (const category of Object.values(EquipmentCategory)) {
      const eq = await createEquipment(actor, {
        name: `${run}_${category}`,
        category,
        mobility: "POOLED",
        status: "OPERATIONAL",
      });
      const model = await createModel(actor, { name: `${run}_${category}`, category });
      for (const row of [await getEquipment(eq.id), await getModel(model.id)])
        expect(row?.kind.systemKey).toBe(DEFAULT_EQUIPMENT_KINDS[category].key);
      const changed = await updateEquipment(actor, eq.id, {
        kindId,
        category,
        mobility: "POOLED",
        status: "OPERATIONAL",
        name: eq.name!,
      });
      expect(changed).toMatchObject({ kindId, category: "OTHER" });
      expect(await updateModel(actor, model.id, { kindId, name: model.name })).toMatchObject({
        kindId,
        category: "OTHER",
      });
    }
    const projector = await db.equipmentKind.findUniqueOrThrow({
      where: { systemKey: "projector" },
    });
    expect(
      await createEquipment(actor, {
        kindId: projector.id,
        mobility: "POOLED",
        status: "OPERATIONAL",
        name: `${run}_kindonly`,
      }),
    ).toMatchObject({ kindId: projector.id, category: "PROJECTOR" });
    await db.equipment.create({ data: { name: `${run}_fallback`, category: "PC" } });
    await db.equipmentModel.create({ data: { name: `${run}_fallback`, category: "PC" } });
    const device = (await listEquipment({ q: `${run}_fallback` }))[0];
    const model = (await listModels({ q: `${run}_fallback` }))[0];
    expect(device.kind.systemKey).toBe("computer");
    expect(model.kind.systemKey).toBe("computer");
    expect((await getEquipment(device.id))?.kind).toEqual(device.kind);
    expect((await getModel(model.id))?.kind).toEqual(model.kind);
    expect(await listEquipment({ kindId: device.kind.id, q: `${run}_fallback` })).toHaveLength(1);
    expect(await listModels({ kindId: model.kind.id, q: `${run}_fallback` })).toHaveLength(1);
    await db.equipment.update({ where: { id: device.id }, data: { kindId: projector.id } });
    await db.equipmentModel.update({ where: { id: model.id }, data: { kindId: projector.id } });
    expect((await getEquipment(device.id))?.kind.systemKey).toBe("computer");
    expect((await getModel(model.id))?.kind.systemKey).toBe("computer");
    expect(await listEquipment({ kindId: device.kind.id, q: `${run}_fallback` })).toHaveLength(1);
    expect(await listModels({ kindId: model.kind.id, q: `${run}_fallback` })).toHaveLength(1);
    expect(await listEquipment({ kindId: projector.id, q: `${run}_fallback` })).toHaveLength(0);
    expect(await listModels({ kindId: projector.id, q: `${run}_fallback` })).toHaveLength(0);
  });

  it("keeps kinds on room clones and CSV/bulk creates, including auto-created models", async () => {
    await db.campus.create({ data: { id: run, name: run, slug: run } });
    const room = await db.room.create({
      data: { name: `${run}_room`, slug: `${run}_room`, campusId: run },
    });
    await createEquipment(actor, {
      name: `${run}_clone`,
      roomId: room.id,
      kindId,
      mobility: "FIXED",
      status: "OPERATIONAL",
    });
    const clone = await cloneRoom(actor, room.slug, {
      name: `${run}_cloned`,
      copyEquipment: true,
      copyCapabilities: false,
      copyFeatures: false,
      copyTips: false,
    });
    expect(await db.equipment.findFirstOrThrow({ where: { roomId: clone.id } })).toMatchObject({
      kindId,
      category: "OTHER",
    });
    const csv = equipmentCsvRowSchema.parse({
      kategorie: "mikrofon",
      mobilitaet: "pool",
      modell: `${run}_csvmodel`,
      name: `${run}_csv`,
    });
    const bulk = await bulkCreateEquipment(actor, [
      csv,
      { ...csv, name: `${run}_bulk`, modelText: `${run}_bulkmodel`, kindId },
    ]);
    const written = await db.equipment.findMany({
      where: { id: { in: bulk.items.map((row) => row.id) } },
      include: { model: true, kind: true },
    });
    expect(written.find((row) => row.name === csv.name)).toMatchObject({
      category: "MICROPHONE",
      kind: { systemKey: "microphone" },
      model: { category: "MICROPHONE" },
    });
    expect(written.find((row) => row.name === `${run}_bulk`)).toMatchObject({
      kindId,
      category: "OTHER",
      model: { kindId, category: "OTHER" },
    });
  });

  it("MCP exposes kind summaries and accepts kind IDs alongside legacy categories", async () => {
    const server = new McpServer({ name: "synthetic", version: "1" });
    registerPlaceWrites(server, {
      user: { ...DEMO_USER, role: "ADMIN" },
      token: { id: run, name: run, scope: "READ_WRITE" },
    });
    registerReadTools(server, {
      user: { ...DEMO_USER, role: "ADMIN" },
      token: { id: run, name: run, scope: "READ_WRITE" },
    });
    const client = new Client({ name: "synthetic", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const value = (result.structuredContent as { result: Record<string, unknown> }).result;
      expect(value).not.toHaveProperty("kindId");
      if (name.startsWith("get_equipment"))
        expect(value.kind).toMatchObject({
          id: expect.any(String),
          key: expect.any(String),
          name: expect.any(String),
          group: { id: expect.any(String), name: expect.any(String) },
        });
      return value;
    };
    try {
      const groups = await call("list_device_kinds", {});
      expect(Array.isArray(groups)).toBe(true);
      expect(JSON.stringify(groups)).toContain(kindId);
      const eq = await call("create_equipment", {
        name: `${run}_mcp`,
        kindId,
        mobility: "POOLED",
      });
      await call("update_equipment", {
        id: eq.id,
        input: {
          name: `${run}_mcp`,
          category: "MICROPHONE",
          mobility: "POOLED",
          attributes: JSON.stringify({ category: "signal", kind: "literal", kindId: "literal" }),
        },
      });
      expect((await getEquipment(eq.id as string))?.kind.systemKey).toBe("microphone");
      expect((await call("get_equipment", { id: eq.id })).attributes).toEqual({
        category: "signal",
        kind: "literal",
        kindId: "literal",
      });
      const model = await call("create_equipment_model", {
        name: `${run}_mcpmodel`,
        kindId,
      });
      await call("update_equipment_model", {
        id: model.id,
        input: { name: `${run}_mcpmodel`, category: "REMOTE" },
      });
      expect((await getModel(model.id as string))?.kind.systemKey).toBe("remote");
      await call("get_equipment_model", { id: model.id });
      const listed = await call("list_equipment", {
        kindId: (await getEquipment(eq.id as string))!.kind.id,
        q: `${run}_mcp`,
      });
      expect(listed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: eq.id,
            kind: expect.objectContaining({ key: "microphone" }),
          }),
        ]),
      );
      const listedModels = await call("list_equipment_models", {
        kindId: (await getModel(model.id as string))!.kind.id,
        q: `${run}_mcpmodel`,
      });
      expect(listedModels.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: model.id,
            kind: expect.objectContaining({ key: "remote" }),
          }),
        ]),
      );
      await call("bulk_create_equipment", {
        rows: [{ kategorie: "PROJECTOR", mobilitaet: "POOLED", name: `${run}_mcpbulk` }],
      });
      expect((await listEquipment({ q: `${run}_mcpbulk` }))[0].kind.systemKey).toBe("projector");
      await call("bulk_create_equipment", {
        rows: [{ kindId, mobilitaet: "POOLED", name: `${run}_mcpkindbulk` }],
      });
      expect((await listEquipment({ q: `${run}_mcpkindbulk` }))[0].kind.id).toBe(kindId);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("demo devices and models are seeded with their category's default kind", async () => {
    for (const [ids, rows] of [
      [
        EQUIPMENT,
        await db.equipment.findMany({
          where: { id: { in: EQUIPMENT.map((row) => row.id) } },
          include: { kind: true },
        }),
      ],
      [
        EQUIPMENT_MODELS,
        await db.equipmentModel.findMany({
          where: { id: { in: EQUIPMENT_MODELS.map((row) => row.id) } },
          include: { kind: true },
        }),
      ],
    ] as const) {
      expect(rows).toHaveLength(ids.length);
      for (const row of rows)
        expect(row.kind?.systemKey).toBe(DEFAULT_EQUIPMENT_KINDS[row.category].key);
    }
  });
});
