import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { getHome } from "../home.queries.server";
import {
  defaultHomeLayout,
  homeLayoutSchema,
  readHomeLayout,
  visibleHomeLayout,
} from "../home-layout";
import { saveOwnHomeLayout } from "~/domains/auth/home-layout.server";
import type { AuthUser } from "~/lib/auth.server";
import { txWithAudit } from "~/lib/audit.server";
import { listHomeChanges } from "../home-activity.queries.server";
import { listTickets } from "~/domains/tickets/tickets.queries.server";
import { reconcileFunctionsInTx } from "~/domains/functions/functions.library.server";

const prefix = `home-${crypto.randomUUID()}`;
const now = new Date("2045-03-26T12:00:00Z");
const earlier = new Date("2025-01-01T00:00:00Z");
const userId = `${prefix}-user`;
const otherId = `${prefix}-other`;
const actor = {
  id: userId,
  name: "Synthetic Home Member",
  role: "MEMBER",
  isActive: true,
} as AuthUser;
let roomIds: string[] = [];
let pictureId: string;
let taskId: string;
let ticketId: string;
let roundId: string;
let linkedTicketId: string;
const eventIds: string[] = [];

beforeAll(async () => {
  await txWithAudit(null, reconcileFunctionsInTx);
  await db.user.createMany({
    data: [userId, otherId].map((id) => ({
      id,
      email: `${id}@example.test`,
      name: "Synthetic Home Member",
    })),
  });
  const rooms = await db.room.createManyAndReturn({
    data: ["old", "limited", "confirmed", "expired"].map((name) => ({
      name: `${prefix}-${name}`,
      slug: `${prefix}-${name}`,
    })),
  });
  roomIds = ["old", "limited", "confirmed", "expired"].map(
    (name) => rooms.find((room) => room.name.endsWith(name))!.id,
  );
  pictureId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } })).id;
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  await db.equipment.createMany({
    data: roomIds.map((roomId) => ({
      roomId,
      kindId: kind.id,
      category: "PROJECTOR" as const,
      name: "Synthetic projector",
      createdAt: earlier,
      updatedAt: earlier,
      statusSince: earlier,
    })),
  });
  const old = await txWithAudit(actor, async (tx, audit) => {
    const row = await tx.ticket.create({
      data: {
        title: `${prefix}-fault`,
        type: "INCIDENT",
        roomId: roomIds[0],
        functionId: pictureId,
        impact: "DOWN",
        occurredAt: new Date("2025-02-01T00:00:00Z"),
        assignees: { connect: { id: userId } },
      },
    });
    await audit({
      action: "TicketCreated",
      entityType: "ticket",
      entityId: row.id,
      occurredAt: now,
    });
    await audit({
      action: "TicketUpdated",
      entityType: "ticket",
      entityId: row.id,
      occurredAt: new Date(+now + 1000),
    });
    return row;
  });
  ticketId = old.id;
  await db.functionOverride.createMany({
    data: [
      {
        roomId: roomIds[1],
        functionId: pictureId,
        state: "LIMITED",
        reason: "Synthetic limited state",
        setAt: new Date("2025-03-01T00:00:00Z"),
        until: new Date(+now + 86_400_000),
      },
      {
        roomId: roomIds[3],
        functionId: pictureId,
        state: "WORKS",
        reason: "Synthetic expired state",
        setAt: new Date("2025-03-01T00:00:00Z"),
        until: new Date(+now - 86_400_000),
      },
    ],
  });
  await db.roomCheck.create({
    data: {
      roomId: roomIds[2],
      functionId: pictureId,
      result: "WORKS",
      checkedAt: new Date(+now - 190 * 86_400_000),
    },
  });
  roundId = (
    await db.round.create({
      data: {
        name: `${prefix}-round`,
        rooms: { create: [{ roomId: roomIds[0] }, { roomId: roomIds[2], completedAt: now }] },
      },
    })
  ).id;
  taskId = (
    await db.task.create({
      data: {
        title: `${prefix}-due-task`,
        status: "TODO",
        dueAt: new Date(+now - 2 * 86_400_000),
        assignees: { create: { userId } },
      },
    })
  ).id;
  linkedTicketId = (
    await db.ticket.create({
      data: {
        title: `${prefix}-linked-fault`,
        type: "INCIDENT",
        roomId: roomIds[0],
        taskId,
        assignees: { connect: { id: userId } },
      },
    })
  ).id;
  await db.task.update({ where: { id: taskId }, data: { ticketId: linkedTicketId } });
  await db.ticket.create({
    data: {
      title: `${prefix}-closed-ticket`,
      type: "INCIDENT",
      roomId: roomIds[0],
      status: "RESOLVED",
      assignees: { connect: { id: userId } },
    },
  });
  await db.task.create({
    data: { title: `${prefix}-done-task`, status: "DONE", assignees: { create: { userId } } },
  });
  await db.task.create({
    data: {
      title: `${prefix}-other-task`,
      status: "TODO",
      assignees: { create: { userId: otherId } },
    },
  });
  for (const [title, start, end, status] of [
    ["inside", "2045-03-26T09:00:00Z", "2045-03-26T10:00:00Z", "PLANNED"],
    ["overnight", "2045-03-25T22:00:00Z", "2045-03-26T00:00:00Z", "PLANNED"],
    ["end-boundary", "2045-03-25T21:00:00Z", "2045-03-25T23:00:00Z", "PLANNED"],
    ["start-boundary", "2045-03-26T22:00:00Z", "2045-03-26T23:00:00Z", "PLANNED"],
    ["cancelled", "2045-03-26T11:00:00Z", "2045-03-26T12:00:00Z", "CANCELLED"],
  ] as const) {
    const row = await db.event.create({
      data: {
        title: `${prefix}-${title}`,
        startsAt: new Date(start),
        endsAt: new Date(end),
        status,
      },
    });
    eventIds.push(row.id);
  }
  await db.eventRoomBooking.create({
    data: {
      eventId: eventIds[0],
      roomId: roomIds[0],
      startsAt: new Date("2045-03-26T09:00:00Z"),
      endsAt: new Date("2045-03-26T10:00:00Z"),
    },
  });
});

afterAll(async () => {
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.round.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.roomCheck.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.functionOverride.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.ticket.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.task.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  await db.$disconnect();
});

describe("home data", () => {
  it("shows oldest affected rooms, open-round progress and only due confirmation/state ends", async () => {
    const data = await getHome(userId, now);
    const rooms = data.faults.rooms.filter((room) => roomIds.includes(room.id));
    expect(rooms.map((room) => room.id)).toEqual(roomIds.slice(0, 2));
    expect(rooms[0].functions).toContainEqual({ id: pictureId, name: "Projektion", state: "DOWN" });
    expect(data.due.rounds.find((round) => round.id === roundId)).toMatchObject({
      done: 1,
      total: 2,
    });
    expect(
      data.due.overrides.filter((row) => row.slug.startsWith(prefix)).map((row) => row.expired),
    ).toEqual([true, false]);
    expect(data.due.confirmations.find((row) => row.slug.endsWith("confirmed"))?.expiresAt).toEqual(
      new Date(+now + 10 * 86_400_000),
    );
  });

  it("uses the 23-hour Berlin day, excludes cancelled events and flags booked rooms with down functions", async () => {
    const data = await getHome(userId, now);
    expect(data.date).toBe("2045-03-26");
    expect(
      data.today.events
        .filter((event) => event.title.startsWith(prefix))
        .map((event) => event.title),
    ).toEqual([`${prefix}-overnight`, `${prefix}-inside`]);
    expect(data.today.events.find((event) => event.id === eventIds[0])?.rooms[0].down).toContain(
      "Projektion",
    );
  });

  it("shows only my open work, due first, and filters general edits out of activity", async () => {
    const data = await getHome(userId, now);
    expect(data.mine.items.map((item) => item.id)).toEqual([taskId, ticketId]);
    expect(data.mine).toMatchObject({ taskCount: 1, ticketCount: 1 });
    expect(data.activity.find((entry) => entry.title === `${prefix}-fault`)?.action).toBe(
      "TicketCreated",
    );
    expect(data.activity.some((entry) => entry.action === "TicketUpdated")).toBe(false);
  });

  it("stores one actor's validated arrangement on the server and audits it without changing another user", async () => {
    const layout = defaultHomeLayout().reverse();
    layout[0].mode = "hide";
    await saveOwnHomeLayout(actor, layout);
    expect((await getHome(userId, now)).layout).toEqual(layout);
    expect((await getHome(otherId, now)).layout).toEqual(defaultHomeLayout());
    expect(
      await db.activityLog.count({
        where: { entityType: "user", entityId: userId, action: "HomeLayoutUpdated" },
      }),
    ).toBe(1);
    await expect(saveOwnHomeLayout(actor, [] as never)).rejects.toThrow();
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).homeLayout).toEqual(layout);
  });

  it("counts a linked task/ticket pair once and uses the same open-only set in the full ticket view", async () => {
    expect((await getHome(userId, now)).mine).toMatchObject({ taskCount: 1, ticketCount: 1 });
    expect((await listTickets({ openWorkForUser: userId })).map((row) => row.id)).toEqual([
      ticketId,
    ]);
    await db.task.update({ where: { id: taskId }, data: { status: "DONE" } });
    try {
      const mine = (await getHome(userId, now)).mine;
      expect(mine).toMatchObject({ taskCount: 0, ticketCount: 2 });
      expect(mine.items.some((row) => row.id === linkedTicketId && row.kind === "ticket")).toBe(
        true,
      );
    } finally {
      await db.task.update({ where: { id: taskId }, data: { status: "TODO" } });
    }
  });
});

describe("layout validation", () => {
  it("defaults missing/corrupt layouts and rejects duplicates or unknown values", () => {
    for (const value of [null, {}, [], [{ id: "faults", mode: "other" }]])
      expect(readHomeLayout(value)).toEqual(defaultHomeLayout());
    const duplicate = defaultHomeLayout();
    duplicate[1] = duplicate[0];
    expect(homeLayoutSchema.safeParse(duplicate).success).toBe(false);
  });
  it("renders highlighted blocks first in stable DOM order and omits hidden blocks", () => {
    const layout = defaultHomeLayout();
    layout[3].mode = "highlight";
    layout[4].mode = "hide";
    expect(visibleHomeLayout(layout).map((row) => row.id)).toEqual([
      "faults",
      "mine",
      "due",
      "today",
    ]);
  });
});

describe("operational changes", () => {
  it("paginates tied timestamps without repeating or skipping changes and excludes account updates", async () => {
    await txWithAudit(actor, async (_tx, audit) => {
      for (const action of ["TicketResolved", "TicketReopened"])
        await audit({ action, entityType: "ticket", entityId: ticketId, occurredAt: now });
      await audit({
        action: "HomeLayoutUpdated",
        entityType: "user",
        entityId: userId,
        occurredAt: now,
      });
    });
    const first = await listHomeChanges(undefined, 1);
    const second = await listHomeChanges(first.nextCursor!, 1);
    const third = await listHomeChanges(second.nextCursor!, 1);
    const ids = [first, second, third].map((page) => page.items[0].id);
    expect(new Set(ids).size).toBe(3);
    expect([first, second, third].map((page) => page.items[0].action).sort()).toEqual([
      "TicketCreated",
      "TicketReopened",
      "TicketResolved",
    ]);
  });
});
