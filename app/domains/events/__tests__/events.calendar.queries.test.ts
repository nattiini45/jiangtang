import { afterAll, describe, expect, it } from "vitest";
import type { EventStatus, Prisma, TaskStatus } from "~/generated/prisma/client";
import { getCalendarData } from "~/domains/events/events.calendar.queries.server";
import { insertOrConflict } from "~/lib/booking.server";
import { db } from "~/lib/db.server";

const RUN = `calendar_${Date.now().toString(36)}`;
const from = new Date("2045-01-10T00:00:00.000Z");
const to = new Date("2045-01-11T00:00:00.000Z");
const before = new Date("2045-01-09T00:00:00.000Z");
const after = new Date("2045-01-12T00:00:00.000Z");
const middle = new Date("2045-01-10T12:00:00.000Z");
const eventIds: string[] = [];
const roomIds: string[] = [];
const equipmentIds: string[] = [];
const taskIds: string[] = [];
const modelIds: string[] = [];

async function makeEvent(
  name: string,
  startsAt = from,
  endsAt = to,
  status: EventStatus = "PLANNED",
) {
  const event = await db.event.create({
    data: { title: `${RUN} ${name}`, startsAt, endsAt, status },
  });
  eventIds.push(event.id);
  return event;
}

async function makeRoom() {
  const name = `${RUN} room ${roomIds.length}`;
  const room = await db.room.create({ data: { name, slug: name.replaceAll(" ", "-") } });
  roomIds.push(room.id);
  return room;
}

async function makeEquipment(data: Partial<Prisma.EquipmentCreateInput> = {}) {
  const equipment = await db.equipment.create({
    data: {
      category: "OTHER",
      mobility: "POOLED",
      name: `${RUN} unit ${equipmentIds.length}`,
      ...data,
    },
  });
  equipmentIds.push(equipment.id);
  return equipment;
}

function book(eventId: string, roomId: string, startsAt = from, endsAt = to, cancelled = false) {
  return insertOrConflict(() =>
    db.eventRoomBooking.create({ data: { eventId, roomId, startsAt, endsAt, cancelled } }),
  );
}

function allocate(
  eventId: string,
  equipmentId: string,
  startsAt = from,
  endsAt = to,
  cancelled = false,
) {
  return insertOrConflict(() =>
    db.equipmentAllocation.create({ data: { eventId, equipmentId, startsAt, endsAt, cancelled } }),
  );
}

afterAll(async () => {
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.equipmentAllocation.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: modelIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.$disconnect();
});

describe("getCalendarData", () => {
  it("uses half-open event overlap, including multi-day and exact-window events", async () => {
    const included = [
      await makeEvent("exact"),
      await makeEvent("ongoing", before, middle),
      await makeEvent("finishes-later", middle, after),
      await makeEvent("spanning", before, after),
    ];
    const excluded = [
      await makeEvent("ends-at-from", before, from),
      await makeEvent("starts-at-to", to, after),
      await makeEvent("outside", after, new Date("2045-01-13T00:00:00.000Z")),
    ];

    const { events } = await getCalendarData({ from, to });
    expect(events.map((e) => e.id)).toEqual(expect.arrayContaining(included.map((e) => e.id)));
    for (const event of excluded) expect(events.map((e) => e.id)).not.toContain(event.id);
    expect(events.find((e) => e.id === included[0].id)).toEqual({
      id: included[0].id,
      title: included[0].title,
      startsAt: from,
      endsAt: to,
      status: "PLANNED",
      rooms: [],
      equipment: [],
    });
    expect(events.map((e) => e.startsAt.getTime())).toEqual(
      events.map((e) => e.startsAt.getTime()).sort((a, b) => a - b),
    );
  });

  it("queries booking times independently of event times and preserves the full booking interval", async () => {
    const room = await makeRoom();
    const spanningRoom = await makeRoom();
    const event = await makeEvent("event-outside", before, from);
    const ongoing = await book(event.id, room.id, before, middle);
    const later = await book(event.id, room.id, middle, after);
    const spanning = await book(event.id, spanningRoom.id, before, after);
    const otherRoom = await makeRoom();
    const ended = await book(event.id, otherRoom.id, before, from);
    const starting = await book(event.id, otherRoom.id, to, after);

    const data = await getCalendarData({ from, to });
    expect(data.events.map((e) => e.id)).not.toContain(event.id);
    const bookings = data.bookings.filter((b) => b.eventId === event.id);
    expect(bookings.map((b) => b.id).sort()).toEqual([ongoing.id, later.id, spanning.id].sort());
    expect(bookings.find((b) => b.id === spanning.id)).toEqual({
      id: spanning.id,
      eventId: event.id,
      title: event.title,
      roomId: spanningRoom.id,
      startsAt: before,
      endsAt: after,
      status: "PLANNED",
    });
    expect(data.bookings.map((b) => b.id)).not.toContain(ended.id);
    expect(data.bookings.map((b) => b.id)).not.toContain(starting.id);
    expect(data.bookings.map((b) => b.startsAt.getTime())).toEqual(
      data.bookings.map((b) => b.startsAt.getTime()).sort((a, b) => a - b),
    );
  });

  it("does not pull in an out-of-window booking just because its event overlaps", async () => {
    const event = await makeEvent("booking-outside");
    const room = await makeRoom();
    const booking = await book(event.id, room.id, before, from);
    const data = await getCalendarData({ from, to });
    expect(data.events.map((e) => e.id)).toContain(event.id);
    expect(data.bookings.map((b) => b.id)).not.toContain(booking.id);
  });

  it("filters rooms by active overlapping bookings, not merely any relation", async () => {
    const room = await makeRoom();
    const otherRoom = await makeRoom();
    const match = await makeEvent("room-match");
    const first = await book(match.id, room.id, from, middle);
    const second = await book(match.id, room.id, middle, to);
    await book(match.id, otherRoom.id);
    const cancelled = await makeEvent("room-cancelled-relation");
    await book(cancelled.id, room.id, from, to, true);
    const early = await makeEvent("room-relation-ends-at-from");
    await book(early.id, room.id, before, from);
    const late = await makeEvent("room-relation-starts-at-to");
    await book(late.id, room.id, to, after);
    await makeEvent("no-room");

    const data = await getCalendarData({ from, to, roomId: room.id });
    expect(data.events.map((e) => e.id)).toEqual([match.id]);
    expect(data.events[0].rooms).toEqual(
      expect.arrayContaining([
        { id: room.id, name: room.name },
        { id: otherRoom.id, name: otherRoom.name },
      ]),
    );
    expect(data.events[0].rooms).toHaveLength(2);
    expect(data.bookings.map((b) => b.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("filters equipment by active overlapping allocations and combines all event filters", async () => {
    const room = await makeRoom();
    const equipment = await makeEquipment();
    const match = await makeEvent("equipment-match", from, to, "CONFIRMED");
    await allocate(match.id, equipment.id, from, middle);
    await allocate(match.id, equipment.id, middle, to);
    const booking = await book(match.id, room.id);
    const cancelled = await makeEvent("equipment-cancelled-relation", from, to, "CONFIRMED");
    await allocate(cancelled.id, equipment.id, from, to, true);
    const early = await makeEvent("equipment-relation-ends-at-from");
    await allocate(early.id, equipment.id, before, from);
    const late = await makeEvent("equipment-relation-starts-at-to");
    await allocate(late.id, equipment.id, to, after);
    const unrelated = await makeEvent("occupancy-without-selected-equipment", from, to, "DONE");
    const unrelatedRoom = await makeRoom();
    const unrelatedBooking = await book(unrelated.id, unrelatedRoom.id);

    const unfiltered = await getCalendarData({ from, to });
    const data = await getCalendarData({ from, to, equipmentId: equipment.id });
    expect(data.events.map((e) => e.id)).toEqual([match.id]);
    expect(data.events[0].equipment).toEqual([{ id: equipment.id, name: equipment.name }]);
    expect(data.bookings).toEqual(unfiltered.bookings);
    expect(data.bookings.map((b) => b.id)).toEqual(
      expect.arrayContaining([booking.id, unrelatedBooking.id]),
    );

    expect(
      (
        await getCalendarData({
          from,
          to,
          equipmentId: equipment.id,
          roomId: room.id,
          status: "CONFIRMED",
        })
      ).events.map((e) => e.id),
    ).toEqual([match.id]);
    const wrongStatus = await getCalendarData({
      from,
      to,
      equipmentId: equipment.id,
      status: "PLANNED",
    });
    expect(wrongStatus.events).toEqual([]);
    expect(wrongStatus.bookings).toEqual(unfiltered.bookings);
    const wrongEquipment = await makeEquipment();
    const hiddenEvent = await getCalendarData({
      from,
      to,
      equipmentId: wrongEquipment.id,
      roomId: room.id,
      status: "PLANNED",
    });
    expect(hiddenEvent.events).toEqual([]);
    expect(hiddenEvent.bookings.map((b) => b.id)).toEqual([booking.id]);
    const wrongRoom = await makeRoom();
    const wrongRoomData = await getCalendarData({
      from,
      to,
      equipmentId: equipment.id,
      roomId: wrongRoom.id,
    });
    expect(wrongRoomData.events).toEqual([]);
    expect(wrongRoomData.bookings).toEqual([]);
  });

  it("retains active bookings of cancelled parents but never shows cancelled bookings", async () => {
    const event = await makeEvent("cancelled-parent", before, from, "CANCELLED");
    const room = await makeRoom();
    const active = await book(event.id, room.id);
    const cancelled = await book(event.id, room.id, from, to, true);
    const equipment = await makeEquipment();
    await allocate(event.id, equipment.id);

    for (const status of [undefined, "CANCELLED"] as const) {
      const data = await getCalendarData({
        from,
        to,
        status,
        roomId: room.id,
        equipmentId: equipment.id,
      });
      expect(data.events).toEqual([]);
      expect(data.bookings.map((b) => b.id)).toEqual([active.id]);
      expect(data.bookings[0].status).toBe("CANCELLED");
      expect(data.bookings.map((b) => b.id)).not.toContain(cancelled.id);
    }
    expect(
      (await getCalendarData({ from, to, status: "PLANNED", roomId: room.id })).bookings.map(
        (b) => b.id,
      ),
    ).toEqual([active.id]);

    const visibleParent = await makeEvent("visible-cancelled-parent", from, to, "CANCELLED");
    const visibleRoom = await makeRoom();
    await book(visibleParent.id, visibleRoom.id, from, to, true);
    await allocate(visibleParent.id, equipment.id, from, to, true);
    const data = await getCalendarData({ from, to, status: "CANCELLED" });
    expect(data.events.find((e) => e.id === visibleParent.id)).toMatchObject({
      rooms: [],
      equipment: [],
    });
  });

  it("returns unfiltered Room pickers and non-retired pooled equipment with useful labels", async () => {
    const room = await makeRoom();
    const model = await db.equipmentModel.create({
      data: { name: `${RUN} Model`, category: "OTHER" },
    });
    modelIds.push(model.id);
    const named = await makeEquipment({ name: `${RUN} Named`, assetTag: "SYNTHETIC-1" });
    const modelOnly = await makeEquipment({
      name: null,
      model: { connect: { id: model.id } },
      status: "FAULTY",
    });
    const categoryOnly = await makeEquipment({ name: null, status: "MAINTENANCE" });
    const retired = await makeEquipment({ status: "RETIRED" });
    const fixed = await makeEquipment({ mobility: "FIXED", room: { connect: { id: room.id } } });

    const data = await getCalendarData({
      from,
      to,
      roomId: room.id,
      equipmentId: retired.id,
      status: "DONE",
    });
    expect(data.rooms).toContainEqual({ id: room.id, name: room.name });
    expect(data.equipment).toEqual(
      expect.arrayContaining([
        { id: named.id, label: `${named.name} · SYNTHETIC-1` },
        { id: modelOnly.id, label: model.name },
        { id: categoryOnly.id, label: "OTHER" },
      ]),
    );
    expect(data.equipment.map((e) => e.id)).not.toContain(retired.id);
    expect(data.equipment.map((e) => e.id)).not.toContain(fixed.id);
  });

  it("optionally returns incomplete tasks due in [from, to), independent of event filters", async () => {
    const fixtures: { dueAt: Date | null; status: TaskStatus }[] = [
      { dueAt: from, status: "TODO" },
      { dueAt: middle, status: "BLOCKED" },
      { dueAt: new Date(to.getTime() - 1), status: "IN_REVIEW" },
      { dueAt: before, status: "TODO" },
      { dueAt: to, status: "TODO" },
      { dueAt: null, status: "TODO" },
      { dueAt: middle, status: "DONE" },
      { dueAt: middle, status: "CANCELLED" },
    ];
    const created = [];
    for (const fixture of fixtures) {
      const task = await db.task.create({
        data: { title: `${RUN} task ${taskIds.length}`, ...fixture },
      });
      taskIds.push(task.id);
      created.push(task);
    }
    expect((await getCalendarData({ from, to })).tasks).toEqual([]);
    expect((await getCalendarData({ from, to, includeTasks: false })).tasks).toEqual([]);
    const room = await makeRoom();
    const data = await getCalendarData({
      from,
      to,
      includeTasks: true,
      roomId: room.id,
      status: "DONE",
    });
    expect(data.tasks.filter((task) => taskIds.includes(task.id))).toEqual(
      created.slice(0, 3).map(({ id, title, dueAt }) => ({ id, title, dueAt })),
    );
  });

  it.each([
    { from: new Date(NaN), to },
    { from, to: new Date(NaN) },
    { from, to: from },
    { from: to, to: from },
    { from, to: new Date(from.getTime() + 367 * 24 * 60 * 60 * 1000) },
  ])("rejects an invalid or unbounded window: %o", async (opts) => {
    await expect(getCalendarData(opts)).rejects.toBeInstanceOf(RangeError);
  });
});
