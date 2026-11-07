import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { listEvents } from "../events.queries.server";

/**
 * `listEvents({ from, to })` uses OVERLAP semantics (endsAt > from AND
 * startsAt < to): an event that started before the window but is still running
 * inside it must be listed — the mobile today/week view depends on it.
 */
const RUN = `evq_${Date.now().toString(36)}`;
const ids: string[] = [];

beforeAll(async () => {
  const mk = async (name: string, startsAt: Date, endsAt: Date) => {
    const e = await db.event.create({
      data: { title: `${RUN} ${name}`, startsAt, endsAt, status: "PLANNED" },
    });
    ids.push(e.id);
    return e;
  };
  // Window under test: [2026-11-10T00:00Z, 2026-11-11T00:00Z)
  const from = new Date("2026-11-10T00:00:00.000Z");
  const to = new Date("2026-11-11T00:00:00.000Z");
  // Starts before the window, ends inside it → in progress → must be listed.
  await mk("ongoing", new Date("2026-11-09T22:00:00.000Z"), new Date("2026-11-10T10:00:00.000Z"));
  // Fully inside → listed.
  await mk("inside", new Date("2026-11-10T09:00:00.000Z"), new Date("2026-11-10T11:00:00.000Z"));
  // Starts before, ends after the window → spans it → listed.
  await mk("spanning", new Date("2026-11-09T00:00:00.000Z"), new Date("2026-11-12T00:00:00.000Z"));
  // Ends exactly at window start → NOT overlapping → excluded.
  await mk("ended-at-start", new Date("2026-11-09T20:00:00.000Z"), from);
  // Starts exactly at window end → NOT overlapping → excluded.
  await mk("starts-at-end", to, new Date("2026-11-11T05:00:00.000Z"));
  // Entirely outside → excluded.
  await mk("outside", new Date("2026-11-20T00:00:00.000Z"), new Date("2026-11-21T00:00:00.000Z"));
  void from;
  void to;
});

afterAll(async () => {
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: ids } } });
  await db.event.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe("listEvents window overlap", () => {
  it("includes events overlapping [from, to), excludes the rest", async () => {
    const from = new Date("2026-11-10T00:00:00.000Z");
    const to = new Date("2026-11-11T00:00:00.000Z");
    const rows = await listEvents({ from, to });
    const mine = rows
      .filter((r) => r.title.startsWith(RUN))
      .map((r) => r.title.slice(RUN.length + 1));
    expect(mine.sort()).toEqual(["inside", "ongoing", "spanning"]);
  });
});
