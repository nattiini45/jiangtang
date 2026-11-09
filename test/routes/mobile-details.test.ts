import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { insertOrConflict } from "~/lib/booking.server";
import { requireUser } from "~/lib/auth.server";
import { loader as loadEvent } from "~/routes/m.events.$id/route";
import { loader as loadNote } from "~/routes/m.notes.$id/route";
import { loader as loadRoom } from "~/routes/m.rooms.$slug/route";
import { calendarRange, parseCalendarDate } from "~/lib/event-calendar";

vi.mock("~/lib/auth.server", async (original) => ({
  ...(await original<typeof import("~/lib/auth.server")>()),
  requireUser: vi.fn(async () => ({ id: "synthetic-member", role: "MEMBER" })),
}));

const run = `mobile_details_${Date.now().toString(36)}`;
const eventIds: string[] = [];
const roomIds: string[] = [];
const noteIds: string[] = [];
const equipmentIds: string[] = [];
const userIds: string[] = [];
const args = (path: string, params: Record<string, string>) =>
  ({
    request: new Request(`http://localhost${path}`),
    params,
  }) as never;
const roomArgs = (slug: string, date?: string) =>
  args(`/m/rooms/${slug}${date ? `?date=${date}` : ""}`, { slug });

async function room() {
  const name = `${run}-${roomIds.length}`;
  const result = await db.room.create({ data: { name, slug: name, status: "TECH_DEFECT" } });
  roomIds.push(result.id);
  return result;
}

async function event(startsAt: Date, endsAt: Date, status: "PLANNED" | "CANCELLED" = "PLANNED") {
  const result = await db.event.create({
    data: {
      title: `${run}-${eventIds.length}`,
      startsAt,
      endsAt,
      status,
      organizer: "Synthetic team",
      contact: "contact@example.test",
      description: "Synthetic description",
    },
  });
  eventIds.push(result.id);
  return result;
}

async function book(
  eventId: string,
  roomId: string,
  startsAt: Date,
  endsAt: Date,
  cancelled = false,
) {
  return insertOrConflict(() =>
    db.eventRoomBooking.create({ data: { eventId, roomId, startsAt, endsAt, cancelled } }),
  );
}

beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  await db.serviceWindow.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.equipmentAllocation.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.note.deleteMany({ where: { id: { in: noteIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.$disconnect();
});

describe("read-only mobile details", () => {
  it("returns actual event, room, allocation and service times from the shared detail query", async () => {
    const r = await room();
    const e = await event(new Date("2046-10-25T09:00Z"), new Date("2046-10-25T10:00Z"));
    const booking = await book(
      e.id,
      r.id,
      new Date("2046-10-25T08:00Z"),
      new Date("2046-10-25T11:00Z"),
    );
    const equipment = await db.equipment.create({
      data: { category: "OTHER", mobility: "POOLED", name: run },
    });
    equipmentIds.push(equipment.id);
    const allocation = await insertOrConflict(() =>
      db.equipmentAllocation.create({
        data: {
          eventId: e.id,
          equipmentId: equipment.id,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
        },
      }),
    );
    const service = await db.serviceWindow.create({
      data: {
        eventId: e.id,
        roomId: r.id,
        kind: "SETUP",
        startsAt: booking.startsAt,
        endsAt: e.startsAt,
        notes: "Synthetic setup",
      },
    });
    const data = await loadEvent(args(`/m/events/${e.id}?date=2046-10-24`, { id: e.id }));
    expect(requireUser).toHaveBeenCalledOnce();
    expect(data.date).toBe("2046-10-24");
    expect(data.detail.event).toMatchObject({
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      contact: e.contact,
      description: e.description,
    });
    expect(data.detail.rooms).toEqual([
      expect.objectContaining({
        id: booking.id,
        roomSlug: r.slug,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      }),
    ]);
    expect(data.detail.allocations).toEqual([
      expect.objectContaining({
        id: allocation.id,
        startsAt: allocation.startsAt,
        endsAt: allocation.endsAt,
      }),
    ]);
    expect(data.detail.serviceWindows).toEqual([
      expect.objectContaining({ id: service.id, notes: service.notes }),
    ]);
  });

  it("uses the event's Berlin date for its default back link and returns Markdown unchanged", async () => {
    const e = await event(new Date("2046-06-01T23:00Z"), new Date("2046-06-02T01:00Z"));
    expect((await loadEvent(args(`/m/events/${e.id}`, { id: e.id }))).date).toBe("2046-06-02");
    const author = await db.user.create({ data: { name: run, email: `${run}@example.test` } });
    userIds.push(author.id);
    const note = await db.note.create({
      data: {
        authorId: author.id,
        title: run,
        body: "# Title\n\n<script>alert(1)</script>",
        tags: ["synthetic"],
        pinned: true,
      },
    });
    noteIds.push(note.id);
    expect((await loadNote(args(`/m/notes/${note.id}`, { id: note.id }))).note).toMatchObject({
      body: note.body,
      tags: note.tags,
      pinned: true,
    });
  });

  it.each([loadEvent, loadNote])("maps a missing entity to 404", async (loader) => {
    await expect(loader(args("/m/missing", { id: `${run}-missing` }))).rejects.toMatchObject({
      status: 404,
    });
  });

  it.each([
    [loadEvent, { id: "missing" }],
    [loadNote, { id: "missing" }],
    [loadRoom, { slug: "missing" }],
  ] as const)("authenticates before looking up a detail", async (loader, params) => {
    vi.mocked(requireUser).mockRejectedValueOnce(new Response(null, { status: 401 }));
    await expect(loader(args("/m/private", params))).rejects.toMatchObject({ status: 401 });
  });
});

describe("room-day bookings", () => {
  it.each([
    ["2026-03-29", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", 23],
    ["2026-10-25", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", 25],
  ])(
    "uses the full Berlin transition day %s with half-open booking overlap",
    async (date, start, end, hours) => {
      const r = await room();
      const from = new Date(start),
        to = new Date(end);
      expect((to.getTime() - from.getTime()) / 3_600_000).toBe(hours);
      const e = await event(new Date("2026-01-01T10:00Z"), new Date("2026-01-01T11:00Z"));
      const before = await book(e.id, r.id, new Date(+from - 3_600_000), from);
      const inside = await book(e.id, r.id, from, to);
      const after = await book(e.id, r.id, to, new Date(+to + 3_600_000));
      const data = await loadRoom(roomArgs(r.slug, date));
      expect(data.date).toBe(date);
      expect(data.data.room.status).toBe("TECH_DEFECT");
      expect(data.bookings.map((booking) => booking.id)).toEqual([inside.id]);
      expect(data.bookings.map((booking) => booking.id)).not.toContain(before.id);
      expect(data.bookings.map((booking) => booking.id)).not.toContain(after.id);
    },
  );

  it("keeps full spanning booking times, scopes to this room and excludes cancellations", async () => {
    const r = await room(),
      other = await room();
    const { from, to } = calendarRange(parseCalendarDate("2046-04-03"), "day");
    const e = await event(new Date(+from + 3_600_000), new Date(+from + 7_200_000));
    const spanning = await book(e.id, r.id, new Date(+from - 3_600_000), new Date(+to + 3_600_000));
    await book(e.id, other.id, from, to);
    await book(e.id, r.id, from, to, true);
    const cancelled = await event(
      new Date(+to + 7_200_000),
      new Date(+to + 10_800_000),
      "CANCELLED",
    );
    await book(cancelled.id, r.id, cancelled.startsAt, cancelled.endsAt);
    const data = await loadRoom(roomArgs(r.slug, "2046-04-03"));
    expect(data.bookings).toEqual([
      expect.objectContaining({
        id: spanning.id,
        startsAt: spanning.startsAt,
        endsAt: spanning.endsAt,
      }),
    ]);
    expect(
      (await loadRoom(roomArgs(r.slug, "2046-04-04"))).bookings.map((b) => b.eventId),
    ).not.toContain(cancelled.id);
  });

  it("canonicalizes an invalid explicit date and returns 404 for a missing room", async () => {
    const r = await room();
    await expect(loadRoom(roomArgs(r.slug, "2026-02-30"))).rejects.toMatchObject({ status: 302 });
    await expect(loadRoom(roomArgs(`${run}-missing`))).rejects.toMatchObject({ status: 404 });
  });
});
