import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, type Tx } from "~/lib/db.server";
import { writeActivity, type AuditFn } from "~/lib/audit.server";
import { BookingConflictError } from "~/lib/booking.server";
import { LocationKind, StockStatus } from "~/generated/prisma/enums";
import {
  ADMIN_SEED_ASSIGNMENTS,
  ADMIN_SEED_TICKET_IDS,
  ALL_SEED_IDS,
  DEMO_TEAM,
  DEMO_USER,
  INVENTORY,
  LOCATIONS,
  NOTES,
  PROJECTS,
  SEED_ID_PREFIX,
  TASKS,
  TICKETS,
  TIME_ENTRIES,
  VENDORS,
  assertCountsMatchSpec,
  atBerlinHour,
} from "../scripts/seed/data";
import {
  EXPECTED_COUNTS,
  EXPECTED_DEMO_USER_COUNT,
  EXPECTED_LOCATION_KIND_COUNT,
  EXPECTED_SEEDED_ROW_COUNT,
  SEED_ACTOR,
  UNTOUCHED_TABLES,
  seedWorkspace,
  totalCreated,
  totalSkipped,
} from "../prisma/seed";

/**
 * CI GUARD.
 *
 * What this proves, and — more importantly — what it CANNOT: it runs the seed
 * inside ONE transaction that is then rolled back, so `pnpm test` leaves the
 * database exactly as it found it and CI needs no extra step: each check points at the step that already performs
 * the work.
 *
 * The claims are deliberately phrased so that each one can go red:
 *
 *  - counts are asserted against **literals** (`EXPECTED_COUNTS`), never against
 *    the seed's own arrays — a test that compared the data to itself would pass
 *    no matter what the data said;
 *  - **both** the total row count and the exact id set are checked, so a seed
 *    that created the right *number* of rows with the wrong ids fails, and one
 *    that created the right ids plus extras fails too;
 *  - the rollback is **proved**, not assumed: the last-but-one test asserts
 *    nothing leaked onto the database outside the transaction;
 *  - `assertCountsMatchSpec()` is itself the tripwire against the seed data
 *    drifting away from behind a green suite.
 *
 * What it cannot prove, and what was proved by hand instead: that
 * `pnpm db:seed` reports FAILURE when the seed fails. That check is not in the suite: a
 * spawned CLI is too slow and too fragile to assert in-suite, so it is run by hand against a
 * failing seed.
 */

afterAll(async () => {
  await db.$disconnect();
});

/**
 * What the database looked like BEFORE this file ran, so the residue check can
 * be relative. Absolute "there are zero seed rows" assertions are correct on
 * CI's empty service and wrong on a developer machine that has already run
 * `pnpm db:seed` — which is the normal state once the seed exists.
 */
const BASELINE = {
  locations: 0,
  tasks: 0,
  tickets: 0,
  timeEntries: 0,
  demoUsers: 0,
  seedAuditRows: 0,
};

beforeAll(async () => {
  BASELINE.locations = await db.location.count();
  BASELINE.tasks = await db.task.count();
  BASELINE.tickets = await db.ticket.count();
  BASELINE.timeEntries = await db.timeEntry.count();
  BASELINE.demoUsers = await db.user.count({
    where: { id: { in: DEMO_TEAM.map((u) => u.id) } },
  });
  BASELINE.seedAuditRows = await countSeedAuditRows(db);
});

class TxRolledBack extends Error {
  constructor() {
    super("seed-integrity: transaction rolled back on purpose");
    this.name = "TxRolledBack";
  }
}

/**
 * Run `fn` inside one transaction that is ALWAYS rolled back.
 *
 * The rollback is a throw placed AFTER the body resolves, not in a `finally`.
 * A `finally` that throws replaces whatever the body threw — so a genuine
 * failure inside a test would be swallowed and reported as a clean rollback.
 * Here a failing body propagates its own error and the catch re-throws
 * anything that is not the exact sentinel instance.
 */
async function inRolledBackTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const rollback = new TxRolledBack();
  let result: T | undefined;
  try {
    await db.$transaction(async (tx) => {
      result = await fn(tx as Tx);
      throw rollback;
    });
  } catch (e) {
    // Identity, not `instanceof`: if the driver ever wrapped the error, this
    // re-throws it rather than pretending the transaction was clean.
    if (e !== rollback) throw e;
  }
  return result as T;
}

/** An `AuditFn` bound to the caller's transaction — the shape `txWithAudit` builds. */
function auditOn(tx: Tx): AuditFn {
  return (input) => writeActivity(tx, { ...input, actor: SEED_ACTOR });
}

/** Only `$queryRaw` is needed, so this works on the client as well as a `tx`. */
type Queryable = Pick<Tx, "$queryRaw">;

async function countSeedAuditRows(q: Queryable): Promise<number> {
  const [row] = await q.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "ActivityLog" WHERE starts_with("entityId", ${SEED_ID_PREFIX})
  `;
  return Number(row?.n ?? 0);
}

/** Count one of the tables the seed must not touch, by name. */
async function countUntouched(tx: Tx, table: (typeof UNTOUCHED_TABLES)[number]): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "${table}"`,
  );
  const raw = rows[0]?.n;
  if (raw === undefined) throw new Error(`countUntouched("${table}") returned no row`);
  return Number(raw);
}

/**
 * One probe per dangling-FK shape, answered by the database rather than by
 * re-deriving the joins in TypeScript. The SQL is fully static — no value is
 * interpolated — and the `starts_with(id,'seed_')` guard scopes each one to the
 * seed's own rows, so a pre-existing dangling row in a developer's database
 * cannot fail the suite.
 */
const ORPHAN_PROBES: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: "Location.parentId",
    sql: `SELECT count(*)::bigint AS n FROM "Location" c LEFT JOIN "Location" p ON p.id=c."parentId" WHERE starts_with(c.id,'seed_') AND c."parentId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Vendor.locationId",
    sql: `SELECT count(*)::bigint AS n FROM "Vendor" c LEFT JOIN "Location" p ON p.id=c."locationId" WHERE starts_with(c.id,'seed_') AND c."locationId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Project.parentProjectId",
    sql: `SELECT count(*)::bigint AS n FROM "Project" c LEFT JOIN "Project" p ON p.id=c."parentProjectId" WHERE starts_with(c.id,'seed_') AND c."parentProjectId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Project.leadId",
    sql: `SELECT count(*)::bigint AS n FROM "Project" c LEFT JOIN "User" p ON p.id=c."leadId" WHERE starts_with(c.id,'seed_') AND c."leadId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Task.projectId",
    sql: `SELECT count(*)::bigint AS n FROM "Task" c LEFT JOIN "Project" p ON p.id=c."projectId" WHERE starts_with(c.id,'seed_') AND c."projectId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Task.parentTaskId",
    sql: `SELECT count(*)::bigint AS n FROM "Task" c LEFT JOIN "Task" p ON p.id=c."parentTaskId" WHERE starts_with(c.id,'seed_') AND c."parentTaskId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Task.locationId",
    sql: `SELECT count(*)::bigint AS n FROM "Task" c LEFT JOIN "Location" p ON p.id=c."locationId" WHERE starts_with(c.id,'seed_') AND c."locationId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Task.createdById",
    sql: `SELECT count(*)::bigint AS n FROM "Task" c LEFT JOIN "User" p ON p.id=c."createdById" WHERE starts_with(c.id,'seed_') AND c."createdById" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Ticket.taskId",
    sql: `SELECT count(*)::bigint AS n FROM "Ticket" c LEFT JOIN "Task" p ON p.id=c."taskId" WHERE starts_with(c.id,'seed_') AND c."taskId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Ticket.reporterId",
    sql: `SELECT count(*)::bigint AS n FROM "Ticket" c LEFT JOIN "User" p ON p.id=c."reporterId" WHERE starts_with(c.id,'seed_') AND c."reporterId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Note.authorId",
    sql: `SELECT count(*)::bigint AS n FROM "Note" c LEFT JOIN "User" p ON p.id=c."authorId" WHERE starts_with(c.id,'seed_') AND c."authorId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Note.projectId",
    sql: `SELECT count(*)::bigint AS n FROM "Note" c LEFT JOIN "Project" p ON p.id=c."projectId" WHERE starts_with(c.id,'seed_') AND c."projectId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Note.locationId",
    sql: `SELECT count(*)::bigint AS n FROM "Note" c LEFT JOIN "Location" p ON p.id=c."locationId" WHERE starts_with(c.id,'seed_') AND c."locationId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "InventoryItem.vendorId",
    sql: `SELECT count(*)::bigint AS n FROM "InventoryItem" c LEFT JOIN "Vendor" p ON p.id=c."vendorId" WHERE starts_with(c.id,'seed_') AND c."vendorId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "InventoryItem.locationId",
    sql: `SELECT count(*)::bigint AS n FROM "InventoryItem" c LEFT JOIN "Location" p ON p.id=c."locationId" WHERE starts_with(c.id,'seed_') AND c."locationId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "InventoryItem.equipmentId",
    sql: `SELECT count(*)::bigint AS n FROM "InventoryItem" c LEFT JOIN "Equipment" p ON p.id=c."equipmentId" WHERE starts_with(c.id,'seed_') AND c."equipmentId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Location.createdById",
    sql: `SELECT count(*)::bigint AS n FROM "Location" c LEFT JOIN "User" p ON p.id=c."createdById" WHERE starts_with(c.id,'seed_') AND c."createdById" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "Vendor.createdById",
    sql: `SELECT count(*)::bigint AS n FROM "Vendor" c LEFT JOIN "User" p ON p.id=c."createdById" WHERE starts_with(c.id,'seed_') AND c."createdById" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "InventoryItem.createdById",
    sql: `SELECT count(*)::bigint AS n FROM "InventoryItem" c LEFT JOIN "User" p ON p.id=c."createdById" WHERE starts_with(c.id,'seed_') AND c."createdById" IS NOT NULL AND p.id IS NULL`,
  },
  // This entry checks "every Task.projectId resolves",
  // which is only a claim if every task has one.
  {
    label: "Task.projectId missing",
    sql: `SELECT count(*)::bigint AS n FROM "Task" WHERE starts_with(id,'seed_') AND "projectId" IS NULL`,
  },
  {
    label: "Note.authorId missing",
    sql: `SELECT count(*)::bigint AS n FROM "Note" WHERE starts_with(id,'seed_') AND "authorId" IS NULL`,
  },
  {
    label: "TimeEntry.userId",
    sql: `SELECT count(*)::bigint AS n FROM "TimeEntry" c LEFT JOIN "User" p ON p.id=c."userId" WHERE starts_with(c.id,'seed_') AND p.id IS NULL`,
  },
  {
    label: "TimeEntry.taskId",
    sql: `SELECT count(*)::bigint AS n FROM "TimeEntry" c LEFT JOIN "Task" p ON p.id=c."taskId" WHERE starts_with(c.id,'seed_') AND c."taskId" IS NOT NULL AND p.id IS NULL`,
  },
  {
    label: "TimeEntry.createdById",
    sql: `SELECT count(*)::bigint AS n FROM "TimeEntry" c LEFT JOIN "User" p ON p.id=c."createdById" WHERE starts_with(c.id,'seed_') AND c."createdById" IS NOT NULL AND p.id IS NULL`,
  },
];

describe("demo seed integrity", () => {
  it.each(["de", "en"] as const)(
    "seeds a bookable room, equipment and a current event in %s without rewriting edits",
    async (locale) => {
      await inRolledBackTx(async (tx) => {
        await tx.eventRoomBooking.deleteMany({ where: { id: "seed_booking_a01" } });
        await tx.event.deleteMany({ where: { id: "seed_event_hybrid" } });
        await tx.equipment.deleteMany({ where: { id: "seed_equipment_projector_a01" } });
        await tx.equipmentModel.deleteMany({ where: { id: "seed_model_projector" } });
        await tx.room.deleteMany({ where: { id: "seed_room_a01" } });

        const audit = auditOn(tx);
        const beforeAudit = await countSeedAuditRows(tx);
        const first = await seedWorkspace(tx, audit, { locale });
        for (const key of [
          "room",
          "equipmentModel",
          "equipment",
          "event",
          "eventRoomBooking",
        ] as const) {
          expect(first.created[key], key).toBe(1);
          expect(first.skipped[key], key).toBe(0);
        }
        expect((await countSeedAuditRows(tx)) - beforeAudit).toBe(first.auditRows);

        const equipment = await tx.equipment.findUniqueOrThrow({
          where: { id: "seed_equipment_projector_a01" },
          include: { room: true, model: true },
        });
        expect(equipment.room).toMatchObject({
          id: "seed_room_a01",
          slug: "demo-a01",
          name: locale === "de" ? "Demo-Raum A.01" : "Demo Room A.01",
        });
        expect(equipment.model).toMatchObject({
          id: "seed_model_projector",
          name: locale === "de" ? "Demo-Projektor" : "Demo Projector",
        });
        expect(equipment.name).toBe(locale === "de" ? "Projektor A.01" : "Projector A.01");

        const booking = await tx.eventRoomBooking.findUniqueOrThrow({
          where: { id: "seed_booking_a01" },
          include: { event: true },
        });
        const { event, ...bookingRow } = booking;
        expect(booking.roomId).toBe(equipment.roomId);
        expect(booking.cancelled).toBe(false);
        expect(event).toMatchObject({
          id: "seed_event_hybrid",
          title: locale === "de" ? "Demo-Hybridveranstaltung" : "Demo Hybrid Event",
          startsAt: atBerlinHour(0, 10),
          endsAt: atBerlinHour(0, 12),
        });
        expect(booking.startsAt).toEqual(event.startsAt);
        expect(booking.endsAt).toEqual(event.endsAt);

        const editedRoom = await tx.room.update({
          where: { id: "seed_room_a01" },
          data: { name: "Edited room" },
        });
        const editedEquipment = await tx.equipment.update({
          where: { id: equipment.id },
          data: { name: "Edited equipment" },
        });
        const editedEvent = await tx.event.update({
          where: { id: booking.eventId },
          data: { title: "Edited event" },
        });
        const second = await seedWorkspace(tx, audit, { locale: locale === "de" ? "en" : "de" });
        expect(totalCreated(second)).toBe(0);
        expect(second.auditRows).toBe(0);
        expect(await tx.room.findUnique({ where: { id: editedRoom.id } })).toEqual(editedRoom);
        expect(await tx.equipment.findUnique({ where: { id: equipment.id } })).toEqual(
          editedEquipment,
        );
        expect(await tx.event.findUnique({ where: { id: booking.eventId } })).toEqual(editedEvent);
        expect(await tx.eventRoomBooking.findUnique({ where: { id: booking.id } })).toEqual(
          bookingRow,
        );
      });
    },
  );

  it("rejects a conflicting demo room booking through the database constraint", async () => {
    await inRolledBackTx(async (tx) => {
      await seedWorkspace(tx, auditOn(tx));
      const booking = await tx.eventRoomBooking.findUniqueOrThrow({
        where: { id: "seed_booking_a01" },
      });
      await tx.eventRoomBooking.update({
        where: { id: booking.id },
        data: { id: "seed_overlap_probe" },
      });
      await expect(seedWorkspace(tx, auditOn(tx))).rejects.toBeInstanceOf(BookingConflictError);
    });
  });

  it("the seed data still matches its published counts", () => {
    // Asserts nothing about the database — it is the tripwire that keeps the
    // arrays and the published numbers from drifting apart behind a green suite.
    expect(() => assertCountsMatchSpec()).not.toThrow();
    expect(EXPECTED_COUNTS).toEqual({
      room: 1,
      equipmentModel: 1,
      equipment: 1,
      event: 1,
      eventRoomBooking: 1,
      location: 8,
      project: 6,
      task: 41,
      taskDependency: 4,
      taskAssignees: 24,
      ticket: 12,
      note: 8,
      inventoryItem: 31,
      vendor: 3,
      timeEntry: 6,
    });
  });

  it("writes exactly the published counts, and nothing else appears", async () => {
    const observed = await inRolledBackTx(async (tx) => {
      const before = {
        room: await tx.room.count(),
        equipmentModel: await tx.equipmentModel.count(),
        equipment: await tx.equipment.count(),
        event: await tx.event.count(),
        eventRoomBooking: await tx.eventRoomBooking.count(),
        location: await tx.location.count(),
        project: await tx.project.count(),
        task: await tx.task.count(),
        taskDependency: await tx.taskDependency.count(),
        taskAssignees: await tx.taskAssignees.count(),
        ticket: await tx.ticket.count(),
        note: await tx.note.count(),
        inventoryItem: await tx.inventoryItem.count(),
        vendor: await tx.vendor.count(),
        timeEntry: await tx.timeEntry.count(),
      };
      const summary = await seedWorkspace(tx, auditOn(tx));
      const after = {
        room: await tx.room.count(),
        equipmentModel: await tx.equipmentModel.count(),
        equipment: await tx.equipment.count(),
        event: await tx.event.count(),
        eventRoomBooking: await tx.eventRoomBooking.count(),
        location: await tx.location.count(),
        project: await tx.project.count(),
        task: await tx.task.count(),
        taskDependency: await tx.taskDependency.count(),
        taskAssignees: await tx.taskAssignees.count(),
        ticket: await tx.ticket.count(),
        note: await tx.note.count(),
        inventoryItem: await tx.inventoryItem.count(),
        vendor: await tx.vendor.count(),
        timeEntry: await tx.timeEntry.count(),
      };
      return { before, after, summary };
    });

    // The counts are asserted RELATIVE to the baseline, not against zero.
    // This suite has to stay green on a developer machine that has already run
    // the seed — which is the normal state once the seed exists — as well as on CI's
    // empty service. An absolute "8 locations in the table" assertion would go
    // red the first time anyone seeded their dev database, and a test that
    // forces you to re-seed to run it is a test nobody runs.
    for (const key of Object.keys(EXPECTED_COUNTS) as (keyof typeof EXPECTED_COUNTS)[]) {
      expect(observed.after[key], `${key} gained rows the seed did not create`).toBe(
        observed.before[key] + observed.summary.created[key],
      );
      // Every expected row is accounted for exactly once: created now, or
      // already there and deliberately left alone.
      expect(observed.summary.created[key] + observed.summary.skipped[key]).toBe(
        EXPECTED_COUNTS[key],
      );
    }

    // On an empty database the seed must create all of them, and skip none.
    if (Object.values(observed.before).every((n) => n === 0)) {
      expect(observed.summary.created).toEqual({ ...EXPECTED_COUNTS });
      expect(observed.summary.skipped).toEqual({
        room: 0,
        equipmentModel: 0,
        equipment: 0,
        event: 0,
        eventRoomBooking: 0,
        location: 0,
        project: 0,
        task: 0,
        taskDependency: 0,
        taskAssignees: 0,
        ticket: 0,
        note: 0,
        inventoryItem: 0,
        vendor: 0,
        timeEntry: 0,
      });
    }
  });

  it("creates the exact rows, not merely the right number of rows", async () => {
    const expected = {
      user: DEMO_TEAM.map((r) => r.id),
      location: LOCATIONS.map((r) => r.id),
      project: PROJECTS.map((r) => r.id),
      task: TASKS.map((r) => r.id),
      ticket: TICKETS.map((r) => r.id),
      note: NOTES.map((r) => r.id),
      inventoryItem: INVENTORY.map((r) => r.id),
      vendor: VENDORS.map((r) => r.id),
      timeEntry: TIME_ENTRIES.map((r) => r.id),
    };

    const observed = await inRolledBackTx(async (tx) => {
      await seedWorkspace(tx, auditOn(tx));
      // One explicit read per model. A shared helper cannot do this: the nine
      // Prisma delegates are a union of incompatible signatures, so a single
      // generic function would have to be told which table it is reading — and
      // asking it to read `Project` from the `location` delegate is exactly the
      // bug this explicit form makes impossible to write.
      const found = {
        user: (
          await tx.user.findMany({
            where: { id: { in: [...expected.user] } },
            select: { id: true },
          })
        ).map((r) => r.id),
        location: (
          await tx.location.findMany({
            where: { id: { in: [...expected.location] } },
            select: { id: true },
          })
        ).map((r) => r.id),
        project: (
          await tx.project.findMany({
            where: { id: { in: [...expected.project] } },
            select: { id: true },
          })
        ).map((r) => r.id),
        task: (
          await tx.task.findMany({
            where: { id: { in: [...expected.task] } },
            select: { id: true },
          })
        ).map((r) => r.id),
        ticket: (
          await tx.ticket.findMany({
            where: { id: { in: [...expected.ticket] } },
            select: { id: true },
          })
        ).map((r) => r.id),
        note: (
          await tx.note.findMany({
            where: { id: { in: [...expected.note] } },
            select: { id: true },
          })
        ).map((r) => r.id),
        inventoryItem: (
          await tx.inventoryItem.findMany({
            where: { id: { in: [...expected.inventoryItem] } },
            select: { id: true },
          })
        ).map((r) => r.id),
        vendor: (
          await tx.vendor.findMany({
            where: { id: { in: [...expected.vendor] } },
            select: { id: true },
          })
        ).map((r) => r.id),
        timeEntry: (
          await tx.timeEntry.findMany({
            where: { id: { in: [...expected.timeEntry] } },
            select: { id: true },
          })
        ).map((r) => r.id),
      };

      // Every seed-prefixed row in every seeded table must be one this seed
      // declared. Written as ONE union query rather than nine dynamic
      // `tx[model].count()` calls, which do not typecheck (the delegates are a
      // union of incompatible signatures) and would be one round trip each.
      const strayRows = await tx.$queryRaw<{ model: string; n: bigint }[]>`
        SELECT 'user' AS model, count(*)::bigint AS n FROM "User"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.user}::text[]))
        UNION ALL SELECT 'location', count(*)::bigint FROM "Location"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.location}::text[]))
        UNION ALL SELECT 'project', count(*)::bigint FROM "Project"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.project}::text[]))
        UNION ALL SELECT 'task', count(*)::bigint FROM "Task"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.task}::text[]))
        UNION ALL SELECT 'ticket', count(*)::bigint FROM "Ticket"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.ticket}::text[]))
        UNION ALL SELECT 'note', count(*)::bigint FROM "Note"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.note}::text[]))
        UNION ALL SELECT 'inventoryItem', count(*)::bigint FROM "InventoryItem"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.inventoryItem}::text[]))
        UNION ALL SELECT 'vendor', count(*)::bigint FROM "Vendor"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.vendor}::text[]))
        UNION ALL SELECT 'timeEntry', count(*)::bigint FROM "TimeEntry"
          WHERE starts_with("id", ${SEED_ID_PREFIX}) AND NOT ("id" = ANY(${expected.timeEntry}::text[]))
      `;

      return {
        found: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.sort()])) as Record<
          keyof typeof expected,
          string[]
        >,
        strays: strayRows.map((r) => ({ model: r.model, n: Number(r.n) })),
      };
    });

    // Counting rows is not enough: the right NUMBER of the wrong rows would
    // pass every count assertion above. These id sets cannot.
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      expect(observed.found[key], `${key} ids must match exactly`).toEqual(
        [...expected[key]].sort(),
      );
    }
    // And nothing else may carry the seed's prefix — the other half of the
    // scoping, without which "filtered to my ids" hides a stray row.
    expect(
      observed.strays.filter((s) => s.n > 0),
      "seed-prefixed rows outside the declared id set",
    ).toEqual([]);
  });

  it("covers every LocationKind exactly once", async () => {
    const observed = await inRolledBackTx(async (tx) => {
      await seedWorkspace(tx, auditOn(tx));
      const seedLocations = LOCATIONS.map((r) => r.id);
      const kinds = (
        await tx.location.findMany({ where: { id: { in: seedLocations } }, select: { kind: true } })
      ).map((r) => r.kind);
      const strays = await tx.location.count({
        where: {
          AND: [{ id: { startsWith: SEED_ID_PREFIX } }, { id: { notIn: seedLocations } }],
        },
      });
      return { kinds, strays };
    });

    expect(observed.strays).toBe(0);
    expect(observed.kinds).toHaveLength(EXPECTED_LOCATION_KIND_COUNT);
    // Every enum value, exactly once. The uniqueness check is what makes this
    // falsifiable: a seed covering seven kinds and duplicating an eighth would
    // pass a bare sort() comparison against the enum.
    expect([...observed.kinds].sort()).toEqual([...Object.values(LocationKind)].sort());
    expect(new Set(observed.kinds).size).toBe(Object.values(LocationKind).length);
  });

  it("every StockStatus value appears among the seed stock items", () => {
    // The demo stock is the showcase: a state nobody can see in the seed is a
    // state a reviewer will never click on. Asserted on the ARRAY — the seed is
    // idempotent (writeOnce skips existing rows), so comparing stored values on
    // an already-seeded dev DB would measure yesterday's data, not the seed.
    const declared = new Set(INVENTORY.map((i) => i.status));
    for (const value of Object.values(StockStatus)) {
      expect(declared.has(value), `seed must contain a ${value} item`).toBe(true);
    }
    // The stock-status rule: quantity-0 items are AVAILABLE (quantity already says "none").
    for (const item of INVENTORY.filter((i) => i.quantity === 0)) {
      expect(item.status, `${item.id} has quantity 0 and must be AVAILABLE`).toBe("AVAILABLE");
    }
  });

  it("has exactly one unassigned stock item, and it is seed_inv_31", () => {
    // Asserted on the ARRAY for the same writeOnce reason as StockStatus —
    // the demo must keep one locationId:null item or the hideUnassigned
    // filter on /inventory/stock stops being demonstrable.
    const unassigned = INVENTORY.filter((i) => i.locationId === null).map((i) => i.id);
    expect(unassigned).toEqual(["seed_inv_31"]);
  });

  it("every seeded foreign key resolves — no orphan anywhere", async () => {
    const results = await inRolledBackTx(async (tx) => {
      await seedWorkspace(tx, auditOn(tx));
      // Sequential, not Promise.all: these all run on ONE transaction
      // connection, and a concurrent burst on a single interactive transaction
      // is not a supported shape. A -1 below means a probe returned no row at
      // all, so the offenders are named rather than silently counted as zero.
      const collected: { label: string; n: number }[] = [];
      for (const probe of ORPHAN_PROBES) {
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(probe.sql);
        const raw = rows[0]?.n;
        collected.push({ label: probe.label, n: raw === undefined ? -1 : Number(raw) });
      }
      return collected;
    });

    const didNotRun = results.filter((r) => r.n < 0).map((r) => r.label);
    expect(didNotRun, "every orphan probe must return a count").toEqual([]);
    const dangling = results.filter((r) => r.n > 0);
    expect(
      dangling.map((d) => `${d.label}=${d.n}`),
      "seeded rows must not reference anything that does not exist",
    ).toEqual([]);
  });

  it("creates exactly three active demo users, and none of them can log in", async () => {
    const ids = DEMO_TEAM.map((u) => u.id);
    const got = await inRolledBackTx(async (tx) => {
      await seedWorkspace(tx, auditOn(tx));
      return {
        users: await tx.user.count({ where: { id: { in: ids } } }),
        accounts: await tx.account.count({ where: { userId: { in: ids } } }),
        sessions: await tx.session.count({ where: { userId: { in: ids } } }),
      };
    });

    expect(got.users).toBe(EXPECTED_DEMO_USER_COUNT);
    // an Account row is what Better Auth authenticates against, so zero
    // Account rows is what makes "this fixture cannot mint a credential" true
    // rather than merely intended — now for all three members. Asserted
    // on stored rows: the credential barrier holds even on a dev database that
    // already carries an older version of a user row.
    expect(got.accounts).toBe(0);
    expect(got.sessions).toBe(0);
    // Active with a weekly capacity — asserted on the DATA, not stored rows:
    // the seed is writeOnce, so a dev DB that already holds `seed_user_demo`
    // keeps its older flags, and comparing those would measure yesterday's
    // data (same precedent as the StockStatus array assertion below).
    for (const member of DEMO_TEAM) {
      expect(member.isActive, `${member.id} must be active`).toBe(true);
      expect(
        member.weeklyCapacityMinutes,
        `${member.id} must carry a weekly capacity`,
      ).not.toBeNull();
    }
    // … but with demo-local mailboxes, never real addresses.
    expect(DEMO_USER.email).toBe("alex@example.test");
  });

  it("writes one audit row per mutation, in the same transaction", async () => {
    const got = await inRolledBackTx(async (tx) => {
      const audit = auditOn(tx);
      const before = await countSeedAuditRows(tx);
      const summary = await seedWorkspace(tx, audit);
      const afterFirst = await countSeedAuditRows(tx);
      const summary2 = await seedWorkspace(tx, audit);
      const afterSecond = await countSeedAuditRows(tx);
      return { before, summary, summary2, afterFirst, afterSecond };
    });

    expect(got.before).toBeGreaterThanOrEqual(0);
    // Audit rows are written for mutations only, and a mutation is only a
    // mutation if the row was actually absent. Once a database is seeded, the
    // correct expectation is ZERO new audit rows, not the seed's row count — which is exactly
    // what makes this a test of the audit rule rather than of the seed's size.
    expect(got.afterFirst).toBe(got.before + got.summary.auditRows);
    expect(got.summary.auditRows).toBe(
      totalCreated(got.summary) + got.summary.demoUsersCreated + got.summary.actorLinks.tickets,
    );
    // Created-now PLUS already-present always accounts for all counted models.
    const published = Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0);
    expect(totalCreated(got.summary) + totalSkipped(got.summary)).toBe(published);

    // A re-run is a no-op, so it must not append a single audit row: the log
    // records things that happened, not runs.
    expect(totalCreated(got.summary2)).toBe(0);
    expect(got.summary2.auditRows).toBe(0);
    expect(got.afterSecond).toBe(got.afterFirst);
  });

  it("assigns demo work to the loading admin when — and only when — an actor is given", async () => {
    // The dashboard's „Demo-Workspace laden" passes the admin's user id so their
    // „Meine Arbeit" card is populated on first load; `pnpm db:seed` passes
    // nothing and must leave a real user's account untouched. The actor here is
    // a throwaway user created inside the rolled-back transaction — it needs to
    // exist only for the FK, not to authenticate.
    const ACTOR_ID = "seed_actor_probe";
    const got = await inRolledBackTx(async (tx) => {
      await tx.user.create({
        data: {
          id: ACTOR_ID,
          email: "actor-probe@example.test",
          name: "Actor Probe",
          initials: "AP",
          role: "ADMIN",
          isActive: true,
          emailVerified: false,
        },
      });
      const noActor = await seedWorkspace(tx, auditOn(tx));
      const withActor = await seedWorkspace(tx, auditOn(tx), { assignToUserId: ACTOR_ID });
      const myTasks = await tx.taskAssignees.findMany({
        where: { userId: ACTOR_ID, taskId: { in: ADMIN_SEED_ASSIGNMENTS.map((a) => a.taskId) } },
        select: { taskId: true, estimateMinutes: true },
      });
      const myTickets = await tx.ticket.findMany({
        where: { id: { in: [...ADMIN_SEED_TICKET_IDS] }, assignees: { some: { id: ACTOR_ID } } },
        select: { id: true },
      });
      const reRun = await seedWorkspace(tx, auditOn(tx), { assignToUserId: ACTOR_ID });
      return { noActor, withActor, myTasks, myTickets, reRun };
    });

    expect(got.noActor.actorLinks).toEqual({ tasks: 0, tickets: 0 });
    expect(got.withActor.actorLinks).toEqual({
      tasks: ADMIN_SEED_ASSIGNMENTS.length,
      tickets: ADMIN_SEED_TICKET_IDS.length,
    });
    expect(got.myTasks).toHaveLength(ADMIN_SEED_ASSIGNMENTS.length);
    expect(got.myTickets).toHaveLength(ADMIN_SEED_TICKET_IDS.length);
    // Idempotent for the actor too: the re-run connects nothing twice.
    expect(got.reRun.actorLinks).toEqual({ tasks: 0, tickets: 0 });
    expect(got.reRun.auditRows).toBe(0);
  });

  it("re-running changes no count", async () => {
    const readCounts = async (tx: Tx) => ({
      room: await tx.room.count(),
      equipmentModel: await tx.equipmentModel.count(),
      equipment: await tx.equipment.count(),
      event: await tx.event.count(),
      eventRoomBooking: await tx.eventRoomBooking.count(),
      taskDependency: await tx.taskDependency.count(),
      taskAssignees: await tx.taskAssignees.count(),
      location: await tx.location.count(),
      project: await tx.project.count(),
      task: await tx.task.count(),
      ticket: await tx.ticket.count(),
      note: await tx.note.count(),
      inventoryItem: await tx.inventoryItem.count(),
      vendor: await tx.vendor.count(),
      timeEntry: await tx.timeEntry.count(),
    });

    const got = await inRolledBackTx(async (tx) => {
      const audit = auditOn(tx);
      const baseline = await readCounts(tx);
      const first = await seedWorkspace(tx, audit);
      const afterFirst = await readCounts(tx);
      const second = await seedWorkspace(tx, audit);
      const afterSecond = await readCounts(tx);
      return { baseline, first, second, afterFirst, afterSecond };
    });

    expect(got.afterSecond).toEqual(got.afterFirst);
    // Absolute only while the counted models start empty; on a seeded dev
    // database the first run legitimately skips rows and the totals are higher.
    if (Object.values(got.baseline).every((n) => n === 0)) {
      expect(got.afterSecond).toEqual({ ...EXPECTED_COUNTS });
      expect(totalCreated(got.first)).toBe(
        Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0),
      );
    }
    // The seed itself always reports the same thing, seeded or not: every
    // expected row is accounted for exactly once — created now, or already
    // there and deliberately left alone — and the second run creates nothing.
    const published = Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0);
    expect(totalCreated(got.first) + totalSkipped(got.first)).toBe(published);
    expect(totalCreated(got.second)).toBe(0);
    expect(totalSkipped(got.second)).toBe(published);
  });

  it("touches nothing outside the seeded models", async () => {
    const got = await inRolledBackTx(async (tx) => {
      const before: Record<string, number> = {};
      for (const table of UNTOUCHED_TABLES) before[table] = await countUntouched(tx, table);
      await seedWorkspace(tx, auditOn(tx));
      const after: Record<string, number> = {};
      for (const table of UNTOUCHED_TABLES) after[table] = await countUntouched(tx, table);
      return { before, after };
    });

    expect(got.after).toEqual(got.before);
  });

  it("leaves no residue: the transaction really was rolled back", async () => {
    // The control on every other test in this file. Without it, "rolled back" is
    // a claim this suite makes about itself, and a seed that leaked 108 rows onto
    // the developer's database — or the CI service — would still read green.
    expect(await db.location.count()).toBe(BASELINE.locations);
    expect(await db.task.count()).toBe(BASELINE.tasks);
    expect(await db.ticket.count()).toBe(BASELINE.tickets);
    expect(await db.timeEntry.count()).toBe(BASELINE.timeEntries);
    expect(await db.user.count({ where: { id: { in: DEMO_TEAM.map((u) => u.id) } } })).toBe(
      BASELINE.demoUsers,
    );
    expect(await db.user.count({ where: { id: "seed_actor_probe" } })).toBe(0);
    expect(await countSeedAuditRows(db)).toBe(BASELINE.seedAuditRows);
  });

  it("seeds the published number of rows, plus the three demo users", () => {
    // An independent re-derivation: the published counts, plus the users that
    // `Note.authorId` (NOT NULL) makes mandatory. If the seed ever starts
    // writing something the counts do not mention, this stops matching.
    const published = Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0);
    expect(published).toBe(148);
    expect(EXPECTED_SEEDED_ROW_COUNT).toBe(published + EXPECTED_DEMO_USER_COUNT);

    // Every id unique and prefixed, so demo rows are identifiable at a glance
    // and cannot collide with anything the application creates.
    const everyId = ALL_SEED_IDS;
    expect(everyId.every((id) => id.startsWith(SEED_ID_PREFIX))).toBe(true);
    expect(new Set(everyId).size).toBe(everyId.length);
  });
});
