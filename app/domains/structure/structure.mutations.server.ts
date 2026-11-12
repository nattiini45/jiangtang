import { z } from "zod";
import { Prisma } from "~/generated/prisma/client";
import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { lockKindStructure, categoryForKind } from "~/lib/equipment-kinds/kinds.server";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import {
  groupCreateSchema,
  groupUpdateSchema,
  kindCreateSchema,
  kindUpdateSchema,
} from "./structure.schema";

export const KIND_LIMIT = 80;
export const GROUP_LIMIT = 30;
export const protectedKindKeys: string[] = Object.values(DEFAULT_EQUIPMENT_KINDS).map(
  (kind) => kind.key,
);

export function structureError(key: Parameters<typeof tr>[0], field = "name"): never {
  throw new ValidationError({ [field]: [tr(key)] });
}

export async function checkStructureLimit(tx: Tx, entity: "kind" | "group", adding = 1) {
  const count =
    entity === "kind"
      ? await tx.equipmentKind.count({ where: { archivedAt: null } })
      : await tx.equipmentFunctionGroup.count({ where: { archivedAt: null } });
  if (count + adding > (entity === "kind" ? KIND_LIMIT : GROUP_LIMIT))
    structureError(entity === "kind" ? "admin.structure.kindLimit" : "admin.structure.groupLimit");
}

export async function queueKindDevices(tx: Tx, kindIds: string[]) {
  const devices = await tx.equipment.findMany({
    where: { kindId: { in: kindIds } },
    select: { id: true },
  });
  for (let offset = 0; offset < devices.length; offset += 500) {
    const values = Prisma.join(
      devices
        .slice(offset, offset + 500)
        .map(
          ({ id }) =>
            Prisma.sql`(gen_random_uuid()::text, 'EQUIPMENT', ${id}, 'reindex', now(), now(), now())`,
        ),
    );
    await tx.$executeRaw`INSERT INTO "SearchIndexJob" (id, "sourceType", "sourceId", op, "nextAttemptAt", "createdAt", "updatedAt") VALUES ${values} ON CONFLICT ("sourceType", "sourceId", op) DO UPDATE SET "updatedAt" = clock_timestamp(), "nextAttemptAt" = now()`;
  }
}

async function activeGroup(tx: Tx, id: string) {
  const group = await tx.equipmentFunctionGroup.findUniqueOrThrow({ where: { id } });
  if (group.archivedAt) structureError("admin.structure.groupArchived", "groupId");
  return group;
}

async function reorder(
  tx: Tx,
  entity: "kind" | "group",
  id: string,
  position: number,
  groupId?: string,
) {
  const rows =
    entity === "kind"
      ? await tx.equipmentKind.findMany({
          where: { groupId, archivedAt: null },
          orderBy: [{ position: "asc" }, { id: "asc" }],
        })
      : await tx.equipmentFunctionGroup.findMany({
          where: { archivedAt: null },
          orderBy: [{ position: "asc" }, { id: "asc" }],
        });
  const moved = rows.find((row) => row.id === id);
  if (!moved) return;
  const ordered = rows.filter((row) => row.id !== id);
  ordered.splice(Math.min(position, ordered.length), 0, moved);
  for (const [index, row] of ordered.entries()) {
    if (entity === "kind")
      await tx.equipmentKind.update({ where: { id: row.id }, data: { position: index } });
    else
      await tx.equipmentFunctionGroup.update({ where: { id: row.id }, data: { position: index } });
  }
}

export async function structureWrite<T>(
  entity: "kind" | "group",
  actor: AuditActor,
  work: Parameters<typeof txWithAudit<T>>[1],
) {
  try {
    const result = await txWithAudit(
      actor,
      async (tx, audit) => {
        await lockKindStructure(tx);
        return work(tx, audit);
      },
      { timeout: 30_000 },
    );
    await emitChange({
      entityType: entity === "kind" ? "equipmentKind" : "equipmentFunctionGroup",
      id: "structure",
      op: "updated",
    });
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") structureError("admin.structure.nameTaken");
      if (error.code === "P2003") structureError("admin.structure.referenced");
    }
    throw error;
  }
}

export async function createFunctionGroup(
  actor: AuditActor,
  input: z.input<typeof groupCreateSchema>,
) {
  const data = groupCreateSchema.parse(input);
  return structureWrite("group", actor, async (tx, audit) => {
    await checkStructureLimit(tx, "group");
    const max = await tx.equipmentFunctionGroup.aggregate({ _max: { position: true } });
    const group = await tx.equipmentFunctionGroup.create({
      data: { ...data, position: (max._max.position ?? -1) + 1 },
    });
    await audit({
      action: "EquipmentFunctionGroupCreated",
      entityType: "equipmentFunctionGroup",
      entityId: group.id,
      data: { name: group.name },
    });
    return group;
  });
}

export async function updateFunctionGroup(
  actor: AuditActor,
  id: string,
  input: z.input<typeof groupUpdateSchema>,
) {
  const data = groupUpdateSchema.parse(input);
  return structureWrite("group", actor, async (tx, audit) => {
    const current = await tx.equipmentFunctionGroup.findUniqueOrThrow({ where: { id } });
    if (
      data.archived === true &&
      (await tx.equipmentKind.count({ where: { groupId: id, archivedAt: null } }))
    )
      structureError("admin.structure.groupInUse");
    if (data.archived === false && current.archivedAt) await checkStructureLimit(tx, "group");
    const group = await tx.equipmentFunctionGroup.update({
      where: { id },
      data: {
        name: data.name,
        archivedAt: data.archived === undefined ? undefined : data.archived ? new Date() : null,
      },
    });
    if (data.position !== undefined) await reorder(tx, "group", id, data.position);
    await queueKindDevices(
      tx,
      (await tx.equipmentKind.findMany({ where: { groupId: id }, select: { id: true } })).map(
        (kind) => kind.id,
      ),
    );
    await audit({
      action:
        data.archived === undefined
          ? "EquipmentFunctionGroupUpdated"
          : data.archived
            ? "EquipmentFunctionGroupArchived"
            : "EquipmentFunctionGroupRestored",
      entityType: "equipmentFunctionGroup",
      entityId: id,
      data: { name: group.name, position: data.position ?? group.position },
    });
    return group;
  });
}

export async function createDeviceKind(actor: AuditActor, input: z.input<typeof kindCreateSchema>) {
  const data = kindCreateSchema.parse(input);
  return structureWrite("kind", actor, async (tx, audit) => {
    await activeGroup(tx, data.groupId);
    await checkStructureLimit(tx, "kind");
    const max = await tx.equipmentKind.aggregate({
      where: { groupId: data.groupId },
      _max: { position: true },
    });
    const kind = await tx.equipmentKind.create({
      data: { ...data, position: (max._max.position ?? -1) + 1, tracksFrequency: false },
    });
    await audit({
      action: "EquipmentKindCreated",
      entityType: "equipmentKind",
      entityId: kind.id,
      data: { name: kind.name, groupId: kind.groupId },
    });
    return kind;
  });
}

export async function updateDeviceKind(
  actor: AuditActor,
  id: string,
  input: z.input<typeof kindUpdateSchema>,
) {
  const data = kindUpdateSchema.parse(input);
  return structureWrite("kind", actor, async (tx, audit) => {
    const current = await tx.equipmentKind.findUniqueOrThrow({ where: { id } });
    if (data.archived && current.systemKey && protectedKindKeys.includes(current.systemKey))
      structureError("admin.structure.protected");
    const groupId = data.groupId ?? current.groupId;
    if (data.groupId !== undefined || data.archived === false) await activeGroup(tx, groupId);
    if (data.archived === false && current.archivedAt) await checkStructureLimit(tx, "kind");
    let deviceCount = 0;
    let modelCount = 0;
    if (data.archived) {
      const devices = await tx.equipment.findMany({ where: { kindId: id }, select: { id: true } });
      const models = await tx.equipmentModel.findMany({
        where: { kindId: id },
        select: { id: true },
      });
      deviceCount = devices.length;
      modelCount = models.length;
      if (deviceCount || modelCount) {
        if (!data.moveDevicesTo || data.moveDevicesTo === id)
          structureError("admin.structure.moveRequired", "moveDevicesTo");
        const target = await tx.equipmentKind.findUniqueOrThrow({
          where: { id: data.moveDevicesTo },
          include: { group: true },
        });
        if (target.archivedAt || target.group.archivedAt)
          structureError("admin.structure.kindArchived", "moveDevicesTo");
        await queueKindDevices(tx, [id]);
        const update = { kindId: target.id, category: categoryForKind(target.systemKey) };
        await tx.equipment.updateMany({ where: { kindId: id }, data: update });
        await tx.equipmentModel.updateMany({ where: { kindId: id }, data: update });
        const change = {
          kind: { from: { id, name: current.name }, to: { id: target.id, name: target.name } },
        };
        for (const device of devices)
          await audit({
            action: "EquipmentUpdated",
            entityType: "equipment",
            entityId: device.id,
            data: change,
          });
        for (const model of models)
          await audit({
            action: "EquipmentModelUpdated",
            entityType: "equipmentModel",
            entityId: model.id,
            data: change,
          });
      }
    }
    const max =
      data.groupId && data.groupId !== current.groupId
        ? await tx.equipmentKind.aggregate({ where: { groupId }, _max: { position: true } })
        : null;
    const kind = await tx.equipmentKind.update({
      where: { id },
      data: {
        name: data.name,
        groupId,
        position: max ? (max._max.position ?? -1) + 1 : undefined,
        archivedAt: data.archived === undefined ? undefined : data.archived ? new Date() : null,
      },
    });
    if (data.position !== undefined) await reorder(tx, "kind", id, data.position, groupId);
    await queueKindDevices(tx, [id]);
    await audit({
      action:
        data.archived === undefined
          ? "EquipmentKindUpdated"
          : data.archived
            ? "EquipmentKindArchived"
            : "EquipmentKindRestored",
      entityType: "equipmentKind",
      entityId: id,
      data: {
        name: kind.name,
        groupId,
        position: data.position ?? kind.position,
        deviceCount,
        modelCount,
      },
    });
    return kind;
  });
}

export function deleteStructureEntry(actor: AuditActor, entity: "kind" | "group", id: string) {
  return structureWrite(entity, actor, async (tx, audit) => {
    if (entity === "kind") {
      const kind = await tx.equipmentKind.findUniqueOrThrow({
        where: { id },
        include: { _count: { select: { equipment: true, models: true } } },
      });
      if (kind.systemKey && protectedKindKeys.includes(kind.systemKey))
        structureError("admin.structure.protected");
      if (!kind.archivedAt || kind._count.equipment || kind._count.models)
        structureError("admin.structure.referenced");
      await tx.equipmentKind.delete({ where: { id } });
      await audit({
        action: "EquipmentKindDeleted",
        entityType: "equipmentKind",
        entityId: id,
        data: { name: kind.name },
      });
    } else {
      const group = await tx.equipmentFunctionGroup.findUniqueOrThrow({
        where: { id },
        include: { _count: { select: { kinds: true } } },
      });
      if (group._count.kinds) structureError("admin.structure.referenced");
      await tx.equipmentFunctionGroup.delete({ where: { id } });
      await audit({
        action: "EquipmentFunctionGroupDeleted",
        entityType: "equipmentFunctionGroup",
        entityId: id,
        data: { name: group.name },
      });
    }
    return { id };
  });
}

export function listStructure() {
  return db.equipmentFunctionGroup.findMany({
    orderBy: [{ position: "asc" }, { id: "asc" }],
    include: {
      kinds: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        include: { _count: { select: { equipment: true, models: true } } },
      },
    },
  });
}
