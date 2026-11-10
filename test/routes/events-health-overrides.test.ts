import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";

const run = `route_health_${crypto.randomUUID()}`;
vi.mock("~/lib/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth.server")>()),
  requireUser: vi.fn(async () => ({ id: null, name: "Synthetic health route member" })),
}));

const desktop = await import("~/routes/_desktop.events.new/route");
const mobile = await import("~/routes/m.events.new/route");
const detail = await import("~/routes/_desktop.events.$id/route");
const auth = await import("~/lib/auth.server");
let roomId: string;
let equipmentId: string;
let eventId: string;
const interval = { startsAt: "2044-06-01T10:00", endsAt: "2044-06-01T11:00" };

beforeAll(async () => {
  roomId = (await db.room.create({ data: { name: run, slug: run, status: "OUT_OF_SERVICE" } })).id;
  equipmentId = (
    await db.equipment.create({
      data: { name: run, status: "FAULTY", mobility: "POOLED", category: "OTHER" },
    })
  ).id;
  eventId = (
    await db.event.create({
      data: {
        title: run,
        startsAt: new Date("2044-06-01T08:00Z"),
        endsAt: new Date("2044-06-01T09:00Z"),
      },
    })
  ).id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  const where = { title: { startsWith: run } };
  const events = await db.event.findMany({ where });
  await db.eventRoomBooking.deleteMany({ where: { event: where } });
  await db.equipmentAllocation.deleteMany({ where: { event: where } });
  await db.calendarOutbox.deleteMany({
    where: { eventUid: { in: events.map((event) => event.uid) } },
  });
  await db.event.deleteMany({ where });
  await db.room.delete({ where: { id: roomId } });
  await db.equipment.delete({ where: { id: equipmentId } });
  await db.$disconnect();
});

async function post(
  surface: "desktop" | "mobile" | "room" | "equipment",
  values: Record<string, string | undefined>,
  locale: "en" | "de",
) {
  const form = new FormData();
  const base =
    surface === "mobile"
      ? {
          title: `${run} ${surface}`,
          roomId,
          date: "2044-06-01",
          startTime: "10:00",
          endTime: "11:00",
        }
      : surface === "desktop"
        ? { title: `${run} ${surface}`, roomId, ...interval }
        : {
            _action: surface === "room" ? "addRoom" : "addAllocation",
            roomId,
            equipmentId,
            ...interval,
          };
  for (const [key, value] of Object.entries({ ...base, ...values }))
    if (value !== undefined) form.set(key, value);
  const request = new Request("http://localhost/events/new", {
    method: "POST",
    headers: { "Accept-Language": locale },
    body: form,
  });
  const route = surface === "desktop" ? desktop : surface === "mobile" ? mobile : detail;
  return runWithLocale(locale, () => route.action({ request, params: { id: eventId } } as never));
}

describe("existing booking write surfaces", () => {
  for (const surface of ["desktop", "mobile", "room", "equipment"] as const) {
    it.each(["en", "de"] as const)(
      `${surface} returns inline structured health errors and accepts explicit confirmation in %s`,
      async (locale) => {
        for (const values of [
          {},
          { healthOverrideConfirmed: "false", healthOverrideReason: "Checked" },
          { healthOverrideConfirmed: "true", healthOverrideReason: "   " },
        ]) {
          const response = await post(surface, values, locale);
          expect(response).toMatchObject({
            init: { status: 422 },
            data: {
              fieldErrors: { healthOverrideReason: [t(locale, "events.health.overrideRequired")] },
              transition: { reason: { code: "HEALTH_OVERRIDE_REQUIRED" } },
            },
          });
          expect(await db.eventRoomBooking.count({ where: { roomId } })).toBe(0);
          expect(await db.equipmentAllocation.count({ where: { equipmentId } })).toBe(0);
        }
        const response = await post(
          surface,
          { healthOverrideConfirmed: "true", healthOverrideReason: "  Checked synthetic use  " },
          locale,
        );
        expect(response).toBeInstanceOf(Response);
        expect((response as Response).status).toBe(302);
        const booking =
          surface === "equipment"
            ? await db.equipmentAllocation.findFirstOrThrow({ where: { equipmentId } })
            : await db.eventRoomBooking.findFirstOrThrow({ where: { roomId } });
        expect(
          (await db.activityLog.findFirstOrThrow({ where: { entityId: booking.id } })).data,
        ).toMatchObject({ healthOverride: { reason: "Checked synthetic use" } });
        if (surface === "equipment")
          await db.equipmentAllocation.delete({ where: { id: booking.id } });
        else await db.eventRoomBooking.delete({ where: { id: booking.id } });
      },
    );
  }

  it("authenticates before parsing or checking health", async () => {
    vi.mocked(auth.requireUser).mockRejectedValueOnce(new Response("Sign in", { status: 401 }));
    await expect(post("room", {}, "en")).rejects.toMatchObject({ status: 401 });
  });
});
