import { db } from "~/lib/db.server";
import { getFunctionStates } from "./functions.queries.server";

export async function roundTargets() {
  const states = await getFunctionStates();
  const rooms = new Map(
    states
      .filter(
        (row) =>
          row.expected ||
          row.hasCarrier ||
          row.faults.some((fault) => fault.functionId === row.functionId),
      )
      .map((row) => [
        row.roomId,
        {
          id: row.roomId,
          name: row.roomName,
          slug: row.roomSlug,
          roomNumber: row.roomNumber,
          buildingName: row.buildingName,
          campusName: row.campusName,
        },
      ]),
  );
  return [...rooms.values()].sort(
    (a, b) =>
      (a.buildingName ?? "").localeCompare(b.buildingName ?? "") ||
      (a.roomNumber ?? a.name).localeCompare(b.roomNumber ?? b.name, undefined, { numeric: true }),
  );
}

export function listRounds() {
  return db.round.findMany({ orderBy: { startedAt: "desc" }, include: { rooms: true } });
}

export async function getRound(id: string) {
  const round = await db.round.findUnique({
    where: { id },
    include: {
      rooms: {
        include: {
          room: {
            select: {
              id: true,
              name: true,
              slug: true,
              roomNumber: true,
              building: { select: { name: true } },
            },
          },
        },
      },
      checks: { include: { ticket: { select: { id: true, title: true, status: true } } } },
    },
  });
  if (!round) return null;
  round.rooms.sort(
    (a, b) =>
      (a.room.building?.name ?? "").localeCompare(b.room.building?.name ?? "") ||
      (a.room.roomNumber ?? a.room.name).localeCompare(
        b.room.roomNumber ?? b.room.name,
        undefined,
        { numeric: true },
      ),
  );
  return {
    ...round,
    done: round.rooms.filter((row) => row.completedAt).length,
    faults: [
      ...new Map(
        round.checks
          .filter((check) => check.result === "DOWN" || check.result === "LIMITED")
          .flatMap((check) => (check.ticket ? [[check.ticket.id, check.ticket] as const] : [])),
      ).values(),
    ],
  };
}
