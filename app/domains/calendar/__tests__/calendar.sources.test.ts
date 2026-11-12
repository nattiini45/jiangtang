import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { calendarSources, calendarChoices } from "../calendar.sources.server";
import { getWorkspaceCalendar } from "../calendar.queries.server";
import { calendarKinds, calendarResourceMatches, legacyCalendarHref } from "~/lib/calendar-entries";
import { calendarRange, parseCalendarDate } from "~/lib/event-calendar";

const prefix = `calendar-${randomUUID()}`;
const range = calendarRange(parseCalendarDate("2045-06-10"), "day");
const date = new Date("2045-06-10T10:00Z");
const later = new Date("2045-06-10T11:00Z");
const before = new Date("2045-06-08T10:00Z");
const after = new Date("2045-06-12T10:00Z");
const ids = (name: string) => `${prefix}-${name}`;

beforeAll(async () => {
  await db.room.create({
    data: {
      id: ids("room"),
      name: "Synthetic room",
      slug: ids("room"),
      renewalFrom: before,
      renewalTo: after,
    },
  });
  await db.equipmentFunctionGroup.create({
    data: { id: ids("group"), name: "Synthetic group", position: 99 },
  });
  for (const name of ["kind", "other-kind"])
    await db.equipmentKind.create({
      data: { id: ids(name), name, position: 99, groupId: ids("group") },
    });
  await db.equipment.create({
    data: {
      id: ids("device"),
      name: "Synthetic device",
      category: "OTHER",
      kindId: ids("kind"),
      roomId: ids("room"),
    },
  });
  await db.equipment.create({
    data: {
      id: ids("other-device"),
      name: "Wrong kind",
      category: "OTHER",
      kindId: ids("other-kind"),
    },
  });
  for (const name of ["event", "outside"])
    await db.event.create({
      data: {
        id: ids(name),
        title: name,
        startsAt: name === "event" ? date : after,
        endsAt: name === "event" ? later : new Date(+after + 3600000),
      },
    });
  await db.eventRoomBooking.create({
    data: { eventId: ids("event"), roomId: ids("room"), startsAt: date, endsAt: later },
  });
  await db.equipmentAllocation.create({
    data: { eventId: ids("event"), equipmentId: ids("device"), startsAt: date, endsAt: later },
  });
  for (const kind of ["SETUP", "STANDBY", "TEARDOWN"] as const) {
    await db.serviceWindow.create({
      data: {
        id: ids(kind),
        eventId: ids("event"),
        kind,
        roomId: ids("room"),
        startsAt: date,
        endsAt: later,
      },
    });
    await db.serviceWindow.create({
      data: {
        id: ids(`outside-${kind}`),
        eventId: ids("outside"),
        kind,
        startsAt: after,
        endsAt: new Date(+after + 3600000),
      },
    });
  }
  for (const status of ["TODO", "DONE", "CANCELLED"] as const)
    await db.task.create({ data: { id: ids(status), title: status, dueAt: date, status } });
  await db.task.create({
    data: { id: ids("task-span"), title: "Spanning work", startAt: before, dueAt: after },
  });
  await db.task.create({ data: { id: ids("task-outside"), title: "Outside work", dueAt: after } });
  await db.task.create({
    data: { id: ids("task-start-only"), title: "Not due yet", startAt: date },
  });
  for (const [name, startAt, dueAt] of [
    ["project-span", before, after],
    ["project-start", date, null],
    ["project-due", null, date],
    ["project-outside", after, after],
  ] as const) {
    await db.project.create({ data: { id: ids(name), name, slug: ids(name), startAt, dueAt } });
  }
  await db.inventoryItem.create({
    data: {
      id: ids("stock"),
      name: "Synthetic stock",
      warrantyExpiresAt: date,
      equipmentId: ids("device"),
    },
  });
  await db.inventoryItem.create({
    data: { id: ids("stock-outside"), name: "Outside stock", warrantyExpiresAt: after },
  });
  for (const name of ["fault", "fault-outside", "request"])
    await db.ticket.create({
      data: {
        id: ids(name),
        title: name,
        type: name === "request" ? "REQUEST" : "INCIDENT",
        occurredAt: name === "fault-outside" ? after : date,
        equipmentId: ids("device"),
      },
    });
  for (const scope of ["ROOM", "EQUIPMENT"] as const) {
    for (const name of ["active", "archived", "empty", "outside"]) {
      await db.customField.create({
        data: {
          id: ids(`${scope}-${name}`),
          scope,
          key: `${name}_${scope.toLowerCase()}_${randomUUID().slice(0, 8)}`,
          name: `Team date ${name}`,
          type: "DATE",
          archivedAt: name === "archived" ? date : null,
          ...(scope === "EQUIPMENT" ? { kinds: { create: { kindId: ids("kind") } } } : {}),
        },
      });
    }
    const customValues = {
      [ids(`${scope}-active`)]: "2045-06-10",
      [ids(`${scope}-archived`)]: "2045-06-10",
      [ids(`${scope}-empty`)]: "",
      [ids(`${scope}-outside`)]: "2045-06-12",
    };
    if (scope === "ROOM")
      await db.room.update({ where: { id: ids("room") }, data: { customValues } });
    else
      await db.equipment.updateMany({
        where: { id: { in: [ids("device"), ids("other-device")] } },
        data: { customValues },
      });
  }
});

afterAll(async () => {
  const where = { id: { startsWith: prefix } };
  await db.eventRoomBooking.deleteMany({ where: { eventId: { startsWith: prefix } } });
  await db.equipmentAllocation.deleteMany({ where: { eventId: { startsWith: prefix } } });
  await db.serviceWindow.deleteMany({ where });
  await db.event.deleteMany({ where });
  await db.task.deleteMany({ where });
  await db.project.deleteMany({ where });
  await db.inventoryItem.deleteMany({ where });
  await db.ticket.deleteMany({ where });
  await db.customFieldKind.deleteMany({ where: { fieldId: { startsWith: prefix } } });
  await db.customField.deleteMany({ where });
  await db.equipment.deleteMany({ where });
  await db.equipmentKind.deleteMany({ where });
  await db.equipmentFunctionGroup.deleteMany({ where });
  await db.room.deleteMany({ where });
});

describe("workspace calendar sources", () => {
  it.each(calendarSources.map((source) => [source.id, source] as const))(
    "%s reads only overlapping entries with record links",
    async (_, source) => {
      const entries = (await source.read(range)).filter((entry) => entry.id.includes(prefix));
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.startsAt < range.to && entry.endsAt > range.from).toBe(true);
        expect(entry.href).toMatch(/^\/(events|tasks|projects|rooms|inventory|tickets)\//);
        expect(entry.id).not.toContain("outside");
        expect(entry.kind).toBeTruthy();
      }
    },
  );

  it("includes complete spans and one-sided project dates, but not settled or start-only tasks", async () => {
    const data = await getWorkspaceCalendar({ ...range, kinds: ["tasks", "projects"] });
    const mine = data.entries.filter((entry) => entry.id.includes(prefix));
    expect(mine.map((entry) => entry.id).sort()).toEqual(
      [
        "task:TODO",
        "task:task-span",
        "project:project-span",
        "project:project-start",
        "project:project-due",
      ]
        .map((key) => {
          const [kind, name] = key.split(":");
          return `${kind}:${ids(name)}`;
        })
        .sort(),
    );
    expect(mine.every((entry) => entry.allDay)).toBe(true);
    expect(mine.find((entry) => entry.id === `task:${ids("TODO")}`)).toMatchObject({
      startsAt: range.from,
      endsAt: range.to,
    });
  });

  it("uses active date definitions and kind applicability, not a fixed field list", async () => {
    const partial = await getWorkspaceCalendar({
      from: new Date("2045-06-10T12:00Z"),
      to: new Date("2045-06-10T13:00Z"),
      kinds: ["tasks", "projects", "dates"],
    });
    expect(partial.entries.some((entry) => entry.id === `task:${ids("TODO")}`)).toBe(true);
    expect(
      partial.entries.filter((entry) => entry.id.startsWith("field:") && entry.id.includes(prefix)),
    ).toHaveLength(2);
    const entries = (await getWorkspaceCalendar({ ...range, kinds: ["dates"] })).entries.filter(
      (entry) => entry.id.startsWith("field:") && entry.id.includes(prefix),
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.title.startsWith("Team date active"))).toBe(true);
    expect(entries.map((entry) => entry.href).sort()).toEqual([
      `/inventory/${ids("device")}`,
      `/rooms/${ids("room")}`,
    ]);
    await db.customField.create({
      data: {
        id: ids("tomorrow"),
        key: `tomorrow_${randomUUID().slice(0, 8)}`,
        name: "Tomorrow's team date",
        scope: "ROOM",
        type: "DATE",
      },
    });
    await db.room.update({
      where: { id: ids("room") },
      data: { customValues: { [ids("tomorrow")]: "2045-06-10" } },
    });
    const next = await getWorkspaceCalendar({ ...range, kinds: ["dates"] });
    expect(next.entries.find((entry) => entry.id.endsWith(ids("tomorrow")))?.title).toBe(
      "Tomorrow's team date · Synthetic room",
    );
  });

  it("hides unassociated work under resource filters and keeps occupancy independent", async () => {
    const kinds = calendarChoices.map((choice) => choice.id);
    for (const filters of [
      { roomId: ids("room") },
      { equipmentId: ids("device") },
      { roomId: ids("room"), equipmentId: ids("device") },
    ]) {
      const data = await getWorkspaceCalendar({ ...range, kinds, ...filters });
      expect(
        data.entries.every((entry) =>
          calendarResourceMatches(entry, filters.roomId, filters.equipmentId),
        ),
      ).toBe(true);
      expect(data.entries.some((entry) => entry.id === `event:${ids("event")}`)).toBe(true);
      expect(
        data.entries.some(
          (entry) => entry.id.startsWith("task:") || entry.id.startsWith("project:"),
        ),
      ).toBe(false);
    }
    const data = await getWorkspaceCalendar({
      ...range,
      kinds: [],
      equipmentId: "missing",
      status: "DONE",
    });
    expect(data.entries).toEqual([]);
    expect(data.bookings.some((booking) => booking.eventId === ids("event"))).toBe(true);
  });

  it("propagates source failures and never silently drops a kind", async () => {
    const spy = vi
      .spyOn(calendarSources[0], "read")
      .mockRejectedValueOnce(new Error("Synthetic failure"));
    try {
      await expect(getWorkspaceCalendar({ ...range, kinds: ["events"] })).rejects.toThrow(
        "Synthetic failure",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects unbounded ranges before reading sources", async () => {
    await expect(
      getWorkspaceCalendar({ from: range.to, to: range.from, kinds: [] }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getWorkspaceCalendar({
        from: range.from,
        to: new Date(+range.from + 367 * 86400000),
        kinds: [],
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("calendar address choices", () => {
  it("defaults everything on except faults and retains an explicit empty choice", () => {
    expect(calendarKinds(new URLSearchParams(), calendarChoices)).toEqual([
      "events",
      "service",
      "tasks",
      "projects",
      "dates",
    ]);
    expect(calendarKinds(new URLSearchParams("kinds="), calendarChoices)).toEqual([]);
    expect(
      calendarKinds(new URLSearchParams("kinds=tasks,projects,faults,unknown"), calendarChoices),
    ).toEqual(["tasks", "projects", "faults"]);
    expect(
      calendarKinds(new URLSearchParams("kinds=tasks&kinds=projects"), calendarChoices),
    ).toEqual(["tasks", "projects"]);
  });
  it.each(["month", "week", "day", "rooms", "calendar"])(
    "redirects old %s addresses without losing date or filters",
    (view) => {
      const href = legacyCalendarHref(
        new URLSearchParams({
          view,
          date: "2026-11-09",
          room: "room",
          equipment: "device",
          status: "CONFIRMED",
          tasks: "1",
        }),
      );
      const url = new URL(href!, "http://localhost");
      expect(url.pathname).toBe("/calendar");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        view: view === "calendar" ? "month" : view,
        date: "2026-11-09",
        room: "room",
        equipment: "device",
        status: "CONFIRMED",
        tasks: "1",
      });
      expect(legacyCalendarHref(new URLSearchParams("view=list"))).toBeNull();
    },
  );
});
