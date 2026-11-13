import { db } from "~/lib/db.server";
import { currentLocale } from "~/i18n/request-locale.server";
import library from "~/lib/equipment-kinds/library.json" with { type: "json" };
import { deriveFunctionState } from "./functions.state";

export async function listRoomFunctions() {
  const locale = currentLocale();
  const functions = await db.roomFunction.findMany({
    where: { archivedAt: null },
    include: { kinds: { include: { kind: { select: { id: true, name: true } } } } },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return functions.map((row) => ({
    ...row,
    name:
      (!row.renamed && library.functions.find((entry) => entry.key === row.systemKey)?.[locale]) ||
      row.name,
  }));
}

export async function getFunctionStates({ roomIds }: { roomIds?: string[] } = {}) {
  const [functions, rooms, devices, faults] = await Promise.all([
    listRoomFunctions(),
    db.room.findMany({
      where: { id: roomIds ? { in: roomIds } : undefined },
      select: { id: true, slug: true, status: true },
    }),
    db.equipment.findMany({
      where: { roomId: roomIds ? { in: roomIds } : { not: null }, status: { not: "RETIRED" } },
      select: {
        id: true,
        name: true,
        roomId: true,
        kindId: true,
        status: true,
        statusSince: true,
        model: { select: { name: true } },
        kind: { select: { name: true } },
        substitutedBy: { select: { id: true, status: true, name: true } },
      },
    }),
    db.ticket.findMany({
      where: {
        type: "INCIDENT",
        status: { in: ["OPEN", "IN_PROGRESS"] },
        OR: [
          { roomId: roomIds ? { in: roomIds } : { not: null } },
          { equipment: { roomId: roomIds ? { in: roomIds } : { not: null } } },
        ],
      },
      select: {
        id: true,
        title: true,
        roomId: true,
        functionId: true,
        equipmentId: true,
        impact: true,
        occurredAt: true,
      },
    }),
  ]);
  return rooms.flatMap((room) => {
    const installed = devices.filter((device) => device.roomId === room.id);
    return functions.flatMap((definition) => {
      const mapped = installed.flatMap((device) => {
        const mapping = definition.kinds.find((link) => link.kindId === device.kindId);
        return mapping
          ? [
              {
                ...device,
                role: mapping.role,
                name: device.name ?? device.model?.name ?? device.kind?.name ?? device.id,
              },
            ]
          : [];
      });
      if (!mapped.length) return [];
      const relevant = faults.filter((fault) =>
        fault.functionId
          ? fault.functionId === definition.id && fault.roomId === room.id
          : mapped.some((device) => device.id === fault.equipmentId),
      );
      return [
        {
          roomId: room.id,
          roomSlug: room.slug,
          functionId: definition.id,
          systemKey: definition.systemKey,
          name: definition.name,
          devices: mapped,
          faults: relevant,
          ...deriveFunctionState(mapped, relevant),
        },
      ];
    });
  });
}

export type RoomFunctionState = Awaited<ReturnType<typeof getFunctionStates>>[number];
