import { db } from "~/lib/db.server";
import { berlinDayIndex, berlinDayStartMs, dayIndexToDateKey } from "~/lib/berlin-days";
import {
  confirmationDays,
  getFunctionStates,
  type RoomFunctionState,
} from "~/domains/functions/functions.queries.server";
import { readHomeLayout } from "./home-layout";
import { listHomeChanges } from "./home-activity.queries.server";
import { myOpenTicketWorkWhere } from "~/domains/tickets/tickets.queries.server";
import { dueReadings } from "~/domains/readings/readings.queries.server";
import { planOccurrences } from "~/domains/plans/plans.queries.server";

export async function getHome(userId: string, now = new Date()) {
  const day = berlinDayIndex(now);
  const from = new Date(berlinDayStartMs(day));
  const to = new Date(berlinDayStartMs(day + 1));
  const taskWhere = {
    status: { notIn: ["DONE", "CANCELLED"] as ["DONE", "CANCELLED"] },
    assignees: { some: { userId } },
  };
  const ticketWhere = myOpenTicketWorkWhere(userId);
  const [user, functions, events, tasks, taskCount, tickets, ticketCount, changes] =
    await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: userId }, select: { homeLayout: true } }),
      getFunctionStates({ now }),
      db.event.findMany({
        where: {
          status: { not: "CANCELLED" },
          OR: [
            { startsAt: { lt: to }, endsAt: { gt: from } },
            { rooms: { some: { cancelled: false, startsAt: { lt: to }, endsAt: { gt: from } } } },
          ],
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        include: {
          rooms: {
            where: { cancelled: false, startsAt: { lt: to }, endsAt: { gt: from } },
            orderBy: { startsAt: "asc" },
            include: { room: { select: { id: true, slug: true, name: true, roomNumber: true } } },
          },
        },
      }),
      db.task.findMany({
        where: taskWhere,
        orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
        take: 8,
        select: {
          id: true,
          title: true,
          dueAt: true,
          status: true,
          project: { select: { name: true } },
        },
      }),
      db.task.count({ where: taskWhere }),
      db.ticket.findMany({
        where: ticketWhere,
        orderBy: [{ task: { dueAt: { sort: "asc", nulls: "last" } } }, { id: "asc" }],
        take: 8,
        select: {
          id: true,
          title: true,
          status: true,
          task: { select: { dueAt: true } },
          room: { select: { name: true } },
        },
      }),
      db.ticket.count({ where: ticketWhere }),
      listHomeChanges(undefined, 8),
    ]);

  const faults = functions
    .filter((row) => row.state === "DOWN" || row.state === "LIMITED")
    .sort((a, b) => {
      const age = (a.since?.getTime() ?? -Infinity) - (b.since?.getTime() ?? -Infinity);
      return Number.isNaN(age) || age === 0 ? a.roomName.localeCompare(b.roomName) : age;
    });
  const rooms = [...new Set(faults.map((row) => row.roomId))].map((roomId) => {
    const rows = faults.filter((row) => row.roomId === roomId);
    const first = rows[0];
    return {
      id: roomId,
      slug: first.roomSlug,
      name: first.roomName,
      number: first.roomNumber,
      location: [first.campusName, first.buildingName].filter(Boolean).join(" · "),
      since: first.since,
      functions: rows.map((row) => ({ id: row.functionId, name: row.name, state: row.state })),
      fault:
        rows.flatMap((row) => row.faults).sort((a, b) => +a.occurredAt - +b.occurredAt)[0]?.title ??
        first.manualReason,
    };
  });
  const work = [
    ...tasks.map((row) => ({
      id: row.id,
      kind: "task" as const,
      title: row.title,
      dueAt: row.dueAt,
      status: row.status,
      context: row.project?.name ?? null,
    })),
    ...tickets.map((row) => ({
      id: row.id,
      kind: "ticket" as const,
      title: row.title,
      dueAt: row.task?.dueAt ?? null,
      status: row.status,
      context: row.room?.name ?? null,
    })),
  ].sort((a, b) => +(a.dueAt ?? Infinity) - +(b.dueAt ?? Infinity) || a.id.localeCompare(b.id));

  return {
    layout: readHomeLayout(user.homeLayout),
    date: dayIndexToDateKey(day),
    now,
    faults: { rooms: rooms.slice(0, 8), roomCount: rooms.length, functionCount: faults.length },
    due: await getHomeDue(functions, now),
    today: {
      count: events.length,
      events: events.slice(0, 8).map((event) => ({
        id: event.id,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        rooms: event.rooms.map((booking) => ({
          ...booking.room,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          down: functions
            .filter((row) => row.roomId === booking.roomId && row.state === "DOWN")
            .map((row) => row.name),
        })),
      })),
    },
    mine: { taskCount, ticketCount, items: work.slice(0, 8) },
    activity: changes.items,
  };
}

export type HomeData = Awaited<ReturnType<typeof getHome>>;

export async function getHomeDue(functions: RoomFunctionState[], now = new Date()) {
  const soon = new Date(+now + 30 * 86_400_000);
  const [rounds, overrides] = await Promise.all([
    db.round.findMany({
      where: { closedAt: null },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      include: { rooms: { select: { completedAt: true } } },
    }),
    db.functionOverride.findMany({
      where: { endedAt: null, until: { lte: soon }, function: { archivedAt: null } },
      orderBy: [{ until: "asc" }, { id: "asc" }],
      include: {
        room: { select: { slug: true, name: true } },
        function: { select: { name: true } },
      },
    }),
  ]);
  const confirmations = functions
    .flatMap((row) => {
      if (row.state !== "WORKS" || row.manualReason || !row.lastCheckedAt) return [];
      const expiresAt = new Date(+row.lastCheckedAt + confirmationDays() * 86_400_000);
      return expiresAt > now && expiresAt <= soon
        ? [
            {
              id: `${row.roomId}:${row.functionId}`,
              room: row.roomName,
              slug: row.roomSlug,
              name: row.name,
              expiresAt,
            },
          ]
        : [];
    })
    .sort((a, b) => +a.expiresAt - +b.expiresAt);
  return {
    rounds: rounds.map((round) => ({
      id: round.id,
      name: round.name,
      done: round.rooms.filter((room) => room.completedAt).length,
      total: round.rooms.length,
    })),
    roundCount: rounds.length,
    overrides: overrides.map((row) => ({
      id: row.id,
      room: row.room.name,
      slug: row.room.slug,
      name:
        functions.find((fn) => fn.roomId === row.roomId && fn.functionId === row.functionId)
          ?.name ?? row.function.name,
      until: row.until!,
      expired: row.until! <= now,
    })),
    overrideCount: overrides.length,
    confirmations,
    confirmationCount: confirmations.length,
    readings: await dueReadings(now),
    plans: (await planOccurrences(now)).filter((row) => row.due && !row.roundId),
  };
}
