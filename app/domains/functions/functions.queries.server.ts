import { db } from "~/lib/db.server";
import { currentLocale } from "~/i18n/request-locale.server";
import library from "~/lib/equipment-kinds/library.json" with { type: "json" };
import { deriveFunctionState } from "./functions.state";
import { readConfig } from "~/lib/config.server";

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
  const [functions, rooms, devices, faults, fixes, checks, overrides] = await Promise.all([
    listRoomFunctions(),
    db.room.findMany({
      where: { id: roomIds ? { in: roomIds } : undefined },
      select: {
        id: true,
        slug: true,
        name: true,
        roomNumber: true,
        campusId: true,
        buildingId: true,
        campus: { select: { name: true } },
        building: { select: { name: true } },
      },
    }),
    db.equipment.findMany({
      where: { roomId: roomIds ? { in: roomIds } : { not: null } },
      select: {
        id: true,
        name: true,
        roomId: true,
        kindId: true,
        status: true,
        statusSince: true,
        createdAt: true,
        updatedAt: true,
        model: { select: { name: true } },
        kind: { select: { name: true } },
        substitutedBy: { select: { id: true, status: true, name: true, updatedAt: true } },
      },
    }),
    db.ticket.findMany({
      where: {
        type: "INCIDENT",
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
        status: true,
        updatedAt: true,
        assignees: { select: { id: true, name: true } },
      },
    }),
    db.ticket.findMany({
      where: {
        roomId: roomIds ? { in: roomIds } : { not: null },
        functionId: { not: null },
        keepAsFix: true,
        status: "RESOLVED",
        type: { in: ["INCIDENT", "REPAIR"] },
      },
      select: {
        id: true,
        roomId: true,
        functionId: true,
        title: true,
        resolution: true,
        resolvedAt: true,
      },
      orderBy: [{ resolvedAt: "desc" }, { id: "asc" }],
    }),
    db.roomCheck.findMany({
      where: { roomId: roomIds ? { in: roomIds } : undefined, result: { not: "NOT_CHECKED" } },
      orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
      distinct: ["roomId", "functionId"],
    }),
    db.functionOverride.findMany({
      where: { roomId: roomIds ? { in: roomIds } : undefined, endedAt: null },
    }),
  ]);
  return rooms.flatMap((room) => {
    const installed = devices.filter((device) => device.roomId === room.id);
    return functions.flatMap((definition) => {
      const mapped = installed.flatMap((device) => {
        const mapping = definition.kinds.find((link) => link.kindId === device.kindId);
        return mapping && device.status !== "RETIRED"
          ? [
              {
                ...device,
                role: mapping.role,
                name: device.name ?? device.model?.name ?? device.kind?.name ?? device.id,
              },
            ]
          : [];
      });
      const knownFixes = fixes.filter(
        (fix) => fix.roomId === room.id && fix.functionId === definition.id,
      );
      if (!mapped.length && !knownFixes.length) return [];
      const relevant = faults.filter((fault) =>
        fault.functionId
          ? fault.functionId === definition.id && fault.roomId === room.id
          : mapped.some((device) => device.id === fault.equipmentId),
      );
      return [
        {
          roomId: room.id,
          roomSlug: room.slug,
          roomName: room.name,
          roomNumber: room.roomNumber,
          campusId: room.campusId,
          buildingId: room.buildingId,
          campusName: room.campus?.name ?? null,
          buildingName: room.building?.name ?? null,
          functionId: definition.id,
          systemKey: definition.systemKey,
          name: definition.name,
          devices: mapped,
          faults: relevant.filter(
            (fault) => fault.status === "OPEN" || fault.status === "IN_PROGRESS",
          ),
          knownFixes,
          ...deriveFunctionState(
            mapped,
            relevant.filter((fault) => fault.status === "OPEN" || fault.status === "IN_PROGRESS"),
            {
              now: new Date(),
              days: confirmationDays(),
              evidenceAt: new Date(
                Math.max(
                  0,
                  ...installed
                    .filter((device) =>
                      definition.kinds.some((link) => link.kindId === device.kindId),
                    )
                    .map((device) =>
                      Math.max(
                        (device.statusSince ?? device.createdAt).getTime(),
                        device.updatedAt.getTime(),
                        device.substitutedBy?.updatedAt.getTime() ?? 0,
                      ),
                    ),
                  ...relevant.map((fault) =>
                    Math.max(fault.updatedAt.getTime(), fault.occurredAt.getTime()),
                  ),
                ),
              ),
              check: checks.find(
                (check) => check.roomId === room.id && check.functionId === definition.id,
              ),
              override: overrides.find(
                (override) => override.roomId === room.id && override.functionId === definition.id,
              ),
            },
          ),
        },
      ];
    });
  });
}

export type RoomFunctionState = Awaited<ReturnType<typeof getFunctionStates>>[number];

export function confirmationDays() {
  const days = readConfig("FUNCTION_CONFIRMATION_DAYS");
  return Number.isInteger(days) && days > 0 ? days : 200;
}

export async function listNotWorking(
  options: {
    functionId?: string;
    functionKey?: string;
    campusId?: string;
    buildingId?: string;
    state?: "DOWN" | "LIMITED";
    unassigned?: boolean;
    newestFirst?: boolean;
  } = {},
) {
  const states = await getFunctionStates();
  return states
    .filter(
      (row) =>
        (row.state === "DOWN" || row.state === "LIMITED") &&
        (!options.functionId || row.functionId === options.functionId) &&
        (!options.functionKey || row.systemKey === options.functionKey) &&
        (!options.campusId || row.campusId === options.campusId) &&
        (!options.buildingId || row.buildingId === options.buildingId) &&
        (!options.state || row.state === options.state) &&
        (!options.unassigned || row.faults.every((fault) => !fault.assignees.length)),
    )
    .sort((a, b) => {
      const age = (a.since?.getTime() ?? -Infinity) - (b.since?.getTime() ?? -Infinity);
      return Number.isNaN(age) || age === 0
        ? a.roomName.localeCompare(b.roomName) || a.functionId.localeCompare(b.functionId)
        : options.newestFirst
          ? -age
          : age;
    });
}
