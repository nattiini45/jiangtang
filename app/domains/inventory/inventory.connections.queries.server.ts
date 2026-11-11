import { db } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import type { Prisma } from "~/generated/prisma/client";

export async function listConnectionTargets(equipmentId: string, q: string) {
  const source = await db.equipment.findUnique({
    where: { id: equipmentId },
    select: { roomId: true },
  });
  if (!source) throw new NotFoundError();
  const where: Prisma.EquipmentWhereInput = {
    id: { not: equipmentId },
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { assetTag: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const select = {
    id: true,
    name: true,
    assetTag: true,
    status: true,
    room: { select: { name: true } },
  } as const;
  const nearby = source.roomId
    ? await db.equipment.findMany({
        where: { AND: [where, { roomId: source.roomId }] },
        select,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: 40,
      })
    : [];
  const elsewhere = await db.equipment.findMany({
    where: {
      AND: [
        where,
        ...(source.roomId ? [{ OR: [{ roomId: null }, { roomId: { not: source.roomId } }] }] : []),
      ],
    },
    select,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 40 - nearby.length,
  });
  return [...nearby, ...elsewhere];
}

export async function freeConnectionPorts(equipmentId: string, targetId: string) {
  if (equipmentId === targetId) throw new ValidationError({}, [tr("ports.sameDevice")]);
  const target = await db.equipment.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      ports: { where: { connectionEnd: null }, orderBy: [{ position: "asc" }, { id: "asc" }] },
    },
  });
  if (!target) throw new NotFoundError();
  const positions = await db.equipmentPort.aggregate({
    where: { equipmentId: targetId },
    _max: { position: true },
  });
  return { ports: target.ports, nextPosition: (positions._max.position ?? -1) + 1 };
}
