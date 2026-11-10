import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { db } from "~/lib/db.server";
import {
  BookingConflictError,
  NotFoundError,
  TransitionError,
  ValidationError,
  toErrorResponse,
} from "~/lib/errors.server";
import { RoomStatus, EquipmentStatus } from "~/generated/prisma/enums";
import {
  addAllocation,
  addRoomBooking,
  addServiceWindow,
  createEventWithBooking,
} from "../events.mutations.server";
import { eventCreateSchema } from "../events.schema";
import { equipmentAllocationAction, roomBookingAction } from "../events.health-policy";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";

const run = `health_policy_${crypto.randomUUID()}`;
const interval = { startsAt: "2042-05-01T10:00", endsAt: "2042-05-01T11:00" };
const eventWhere = { title: { startsWith: run } };
const actor = { id: "", name: run, initials: "HP" };
let eventId: string;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const confirmed = {
  healthOverrideConfirmed: true,
  healthOverrideReason: "  Checked alternate safe use  ",
};

beforeAll(async () => {
  actor.id = (await db.user.create({ data: { email: `${run}@example.test`, name: run } })).id;
  eventId = (
    await db.event.create({
      data: {
        title: run,
        startsAt: new Date("2042-05-01T08:00Z"),
        endsAt: new Date("2042-05-01T09:00Z"),
      },
    })
  ).id;
});

afterAll(async () => {
  const events = await db.event.findMany({ where: eventWhere });
  await db.serviceWindow.deleteMany({ where: { event: eventWhere } });
  await db.eventRoomBooking.deleteMany({ where: { event: eventWhere } });
  await db.equipmentAllocation.deleteMany({ where: { event: eventWhere } });
  await db.calendarOutbox.deleteMany({
    where: { eventUid: { in: events.map((event) => event.uid) } },
  });
  await db.event.deleteMany({ where: eventWhere });
  await db.room.deleteMany({ where: { slug: { startsWith: run } } });
  await db.equipment.deleteMany({ where: { name: { startsWith: run } } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await pool.end();
  await db.$disconnect();
});

function room(status: RoomStatus) {
  return db.room.create({ data: { name: run, slug: `${run}_${crypto.randomUUID()}`, status } });
}

function equipment(status: EquipmentStatus, mobility: "FIXED" | "POOLED" = "POOLED") {
  return db.equipment.create({ data: { name: run, status, mobility, category: "OTHER" } });
}

async function snapshot() {
  return {
    events: await db.event.count({ where: eventWhere }),
    rooms: await db.eventRoomBooking.count({ where: { event: eventWhere } }),
    equipment: await db.equipmentAllocation.count({ where: { event: eventWhere } }),
    audit: await db.activityLog.count({ where: { actorId: actor.id } }),
    outbox: await db.calendarOutbox.count({
      where: { payload: { path: ["title"], string_starts_with: run } },
    }),
  };
}

const overrides = [undefined, false, true].flatMap((healthOverrideConfirmed) =>
  [undefined, "", "   ", "  Checked alternate safe use  "].map((healthOverrideReason) => ({
    healthOverrideConfirmed,
    healthOverrideReason,
  })),
);

describe("authoritative booking health policy", () => {
  for (const seam of ["initial", "later"] as const) {
    for (const status of Object.values(RoomStatus)) {
      it.each(overrides)(`${seam} ${status} with %j`, async (override) => {
        const asset = await room(status);
        const input = { roomId: asset.id, ...interval, ...override };
        const before = await snapshot();
        const result = await (
          seam === "initial"
            ? createEventWithBooking(
                actor,
                eventCreateSchema.parse({ title: `${run} initial`, ...interval }),
                input,
              )
            : addRoomBooking(actor, eventId, input)
        ).catch((error: unknown) => error);
        const needsOverride = status === "OUT_OF_SERVICE";
        if (
          needsOverride &&
          (override.healthOverrideConfirmed !== true || !override.healthOverrideReason?.trim())
        ) {
          expect(result).toBeInstanceOf(TransitionError);
          expect(result).toMatchObject({
            transition: {
              entity: "room",
              currentState: status,
              attemptedTarget: "BOOK",
              allowedActions: [roomBookingAction(status)],
              reason: { code: "HEALTH_OVERRIDE_REQUIRED" },
            },
          });
          expect(await snapshot()).toEqual(before);
          return;
        }
        expect(result).not.toBeInstanceOf(Error);
        const booking =
          seam === "initial"
            ? await db.eventRoomBooking.findFirstOrThrow({
                where: { eventId: (result as { id: string }).id },
              })
            : (result as { id: string });
        const audit = await db.activityLog.findFirstOrThrow({
          where: { entityId: booking.id, action: "RoomBooked" },
        });
        expect(audit.actorId).toBe(actor.id);
        expect(audit.actorSnapshot).toMatchObject({ name: run });
        expect(audit.data).toEqual({
          roomId: asset.id,
          ...(needsOverride
            ? { healthOverride: { status, reason: "Checked alternate safe use" } }
            : {}),
        });
      });
    }
  }

  for (const status of Object.values(EquipmentStatus)) {
    it.each(overrides)(`pooled ${status} with %j`, async (override) => {
      const asset = await equipment(status);
      const before = await snapshot();
      const result = await addAllocation(actor, eventId, {
        equipmentId: asset.id,
        ...interval,
        ...override,
      }).catch((error: unknown) => error);
      if (status === "RETIRED") {
        expect(result).toBeInstanceOf(ValidationError);
        expect(result).not.toBeInstanceOf(TransitionError);
        expect(await snapshot()).toEqual(before);
        return;
      }
      const needsOverride = status !== "OPERATIONAL";
      if (
        needsOverride &&
        (override.healthOverrideConfirmed !== true || !override.healthOverrideReason?.trim())
      ) {
        expect(result).toBeInstanceOf(TransitionError);
        expect(result).toMatchObject({
          transition: {
            entity: "equipment",
            currentState: status,
            attemptedTarget: "ALLOCATE",
            allowedActions: [equipmentAllocationAction(status, "POOLED")],
            reason: { code: "HEALTH_OVERRIDE_REQUIRED" },
          },
        });
        expect(await snapshot()).toEqual(before);
        return;
      }
      expect(result).not.toBeInstanceOf(Error);
      const audit = await db.activityLog.findFirstOrThrow({
        where: { entityId: (result as { id: string }).id, action: "EquipmentAllocated" },
      });
      expect(audit.actorId).toBe(actor.id);
      expect(audit.data).toEqual({
        equipmentId: asset.id,
        ...(needsOverride
          ? { healthOverride: { status, reason: "Checked alternate safe use" } }
          : {}),
      });
    });
  }

  it.each(["en", "de"] as const)("maps the shared structured rejection in %s", async (locale) => {
    const asset = await room("OUT_OF_SERVICE");
    const error = await runWithLocale(locale, () =>
      addRoomBooking(actor, eventId, { roomId: asset.id, ...interval }),
    ).catch((error: unknown) => error);
    const response = runWithLocale(locale, () => toErrorResponse(error));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      formErrors: [t(locale, "events.health.overrideRequired")],
      transition: {
        reason: {
          code: "HEALTH_OVERRIDE_REQUIRED",
          message: t(locale, "events.health.overrideRequired"),
        },
      },
    });
  });

  it("preserves missing-reference, cancelled-parent and mobility priority", async () => {
    const asset = await room("OUT_OF_SERVICE");
    const fixed = await equipment("FAULTY", "FIXED");
    const before = await snapshot();
    await expect(
      addRoomBooking(actor, "missing", { roomId: asset.id, ...interval }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      addRoomBooking(actor, eventId, { roomId: "missing", ...interval }),
    ).rejects.toMatchObject({ fieldErrors: { roomId: expect.any(Array) } });
    await expect(
      addAllocation(actor, eventId, { equipmentId: "missing", ...interval }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      addAllocation(actor, eventId, { equipmentId: fixed.id, ...interval, ...confirmed }),
    ).rejects.toMatchObject({ fieldErrors: { equipmentId: expect.any(Array) } });
    expect(equipmentAllocationAction("FAULTY", "FIXED").allowed).toBe(false);
    expect(equipmentAllocationAction("RETIRED", "POOLED").allowed).toBe(false);
    expect(await snapshot()).toEqual(before);
    const cancelled = await db.event.create({
      data: {
        title: `${run} cancelled`,
        status: "CANCELLED",
        startsAt: new Date("2042-05-01T08:00Z"),
        endsAt: new Date("2042-05-01T09:00Z"),
      },
    });
    for (const operation of [
      () => addRoomBooking(actor, cancelled.id, { roomId: asset.id, ...interval, ...confirmed }),
      () =>
        addAllocation(actor, cancelled.id, { equipmentId: fixed.id, ...interval, ...confirmed }),
      () =>
        createEventWithBooking(
          actor,
          eventCreateSchema.parse({
            title: `${run} cancelled initial`,
            status: "CANCELLED",
            ...interval,
          }),
          { roomId: asset.id, ...interval, ...confirmed },
        ),
    ]) {
      const before = await snapshot();
      await expect(operation()).rejects.toMatchObject({
        fieldErrors: { eventId: expect.any(Array) },
      });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("leaves old reservations intact and does not gate service windows", async () => {
    const r = await room("ALL_GOOD");
    const e = await equipment("OPERATIONAL");
    const booking = await addRoomBooking(actor, eventId, { roomId: r.id, ...interval });
    const allocation = await addAllocation(actor, eventId, { equipmentId: e.id, ...interval });
    await db.room.update({ where: { id: r.id }, data: { status: "OUT_OF_SERVICE" } });
    await db.equipment.update({ where: { id: e.id }, data: { status: "RETIRED" } });
    expect(await db.eventRoomBooking.findUnique({ where: { id: booking.id } })).toEqual(booking);
    expect(await db.equipmentAllocation.findUnique({ where: { id: allocation.id } })).toEqual(
      allocation,
    );
    await expect(
      addServiceWindow(actor, eventId, { roomId: r.id, kind: "SETUP", ...interval }),
    ).resolves.toMatchObject({ roomId: r.id });
  });

  it.each(["initial", "later", "equipment"] as const)(
    "confirmed %s override still hits the EXCLUDE constraint atomically",
    async (seam) => {
      const asset = seam === "equipment" ? await equipment("FAULTY") : await room("OUT_OF_SERVICE");
      const operation = () =>
        seam === "equipment"
          ? addAllocation(actor, eventId, { equipmentId: asset.id, ...interval, ...confirmed })
          : seam === "initial"
            ? createEventWithBooking(
                actor,
                eventCreateSchema.parse({ title: `${run} overlap`, ...interval }),
                { roomId: asset.id, ...interval, ...confirmed },
              )
            : addRoomBooking(actor, eventId, { roomId: asset.id, ...interval, ...confirmed });
      await operation();
      const before = await snapshot();
      await expect(operation()).rejects.toBeInstanceOf(BookingConflictError);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(
    (["initial", "later", "equipment"] as const).flatMap((seam) =>
      [false, true].map((override) => ({ seam, override })),
    ),
  )(
    "$seam waits for a concurrent status update with override=$override and checks its committed current state",
    async ({ seam, override }) => {
      const isEquipment = seam === "equipment";
      const asset = isEquipment ? await equipment("OPERATIONAL") : await room("ALL_GOOD");
      const connection = await pool.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await connection.query("BEGIN");
        const pid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await connection.query(
          isEquipment
            ? 'UPDATE "Equipment" SET "status" = \'FAULTY\' WHERE "id" = $1'
            : 'UPDATE "Room" SET "status" = \'OUT_OF_SERVICE\' WHERE "id" = $1',
          [asset.id],
        );
        const operation = () =>
          isEquipment
            ? addAllocation(actor, eventId, {
                equipmentId: asset.id,
                ...interval,
                ...(override ? confirmed : {}),
              })
            : seam === "initial"
              ? createEventWithBooking(
                  actor,
                  eventCreateSchema.parse({ title: `${run} concurrent`, ...interval }),
                  { roomId: asset.id, ...interval, ...(override ? confirmed : {}) },
                )
              : addRoomBooking(actor, eventId, {
                  roomId: asset.id,
                  ...interval,
                  ...(override ? confirmed : {}),
                });
        pending.push(operation().catch((error: unknown) => error));
        await vi.waitFor(
          async () => {
            const { rows } = await pool.query<{ query: string }>(
              "SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
              [pid],
            );
            expect(
              rows.some(
                (row) =>
                  row.query.includes("FOR UPDATE") &&
                  row.query.includes(isEquipment ? '"Equipment"' : '"Room"'),
              ),
            ).toBe(true);
          },
          { interval: 20, timeout: 3000 },
        );
        await connection.query("COMMIT");
        const result = await pending[0];
        if (!override) {
          expect(result).toBeInstanceOf(TransitionError);
        } else {
          expect(result).not.toBeInstanceOf(Error);
          const booking =
            seam === "initial"
              ? await db.eventRoomBooking.findFirstOrThrow({
                  where: { eventId: (result as { id: string }).id },
                })
              : (result as { id: string });
          const audit = await db.activityLog.findFirstOrThrow({
            where: {
              entityId: booking.id,
              action: isEquipment ? "EquipmentAllocated" : "RoomBooked",
            },
          });
          expect(audit.actorId).toBe(actor.id);
          expect(audit.data).toMatchObject({
            healthOverride: {
              status: isEquipment ? "FAULTY" : "OUT_OF_SERVICE",
              reason: "Checked alternate safe use",
            },
          });
        }
      } finally {
        await connection.query("ROLLBACK");
        await Promise.all(pending);
        connection.release();
      }
    },
  );

  it.each(["room", "equipment"] as const)(
    "allows %s after a concurrent repair without requiring a stale override",
    async (entity) => {
      const asset =
        entity === "room" ? await room("OUT_OF_SERVICE") : await equipment("MAINTENANCE");
      const connection = await pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await connection.query("BEGIN");
        const pid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await connection.query(
          entity === "room"
            ? 'UPDATE "Room" SET "status" = \'ALL_GOOD\' WHERE "id" = $1'
            : 'UPDATE "Equipment" SET "status" = \'OPERATIONAL\' WHERE "id" = $1',
          [asset.id],
        );
        pending = (
          entity === "room"
            ? addRoomBooking(actor, eventId, { roomId: asset.id, ...interval })
            : addAllocation(actor, eventId, { equipmentId: asset.id, ...interval })
        ).catch((error: unknown) => error);
        await vi.waitFor(
          async () => {
            expect(
              Number(
                (
                  await pool.query(
                    "SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
                    [pid],
                  )
                ).rows[0].count,
              ),
            ).toBeGreaterThan(0);
          },
          { interval: 20, timeout: 3000 },
        );
        await connection.query("COMMIT");
        expect(await pending).not.toBeInstanceOf(Error);
      } finally {
        await connection.query("ROLLBACK");
        await pending;
        connection.release();
      }
    },
  );
});
