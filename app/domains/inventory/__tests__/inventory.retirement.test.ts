import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as auditServer from "~/lib/audit.server";
import { db } from "~/lib/db.server";
import {
  createEquipment,
  retireEquipment,
  setSubstitution,
  updateEquipment,
} from "~/domains/inventory/inventory.mutations.server";
import {
  equipmentCreateSchema,
  type EquipmentEditInput,
} from "~/domains/inventory/inventory.schema";

const RUN = `retirement_${Date.now()}`;
const actor = { id: null, name: "Retirement Tester", initials: "RT" };
const equipmentIds: string[] = [];
const roomId = `${RUN}_room`;
const campusId = `${RUN}_campus`;
const eventIds: string[] = [];

beforeAll(async () => {
  await db.campus.create({ data: { id: campusId, name: campusId, slug: campusId } });
  await db.room.create({ data: { id: roomId, name: roomId, slug: roomId, campusId } });
});

afterAll(async () => {
  await db.equipmentAllocation.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.equipment.updateMany({
    where: { id: { in: equipmentIds } },
    data: { substitutingForId: null },
  });
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.room.delete({ where: { id: roomId } });
  await db.campus.delete({ where: { id: campusId } });
  await db.$disconnect();
});

function editInput(overrides: Partial<EquipmentEditInput> = {}): EquipmentEditInput {
  return equipmentCreateSchema.parse({ category: "PC", mobility: "POOLED", ...overrides });
}

async function createUnit() {
  const equipment = await createEquipment(actor, editInput());
  equipmentIds.push(equipment.id);
  return equipment;
}

async function substitutionChain() {
  const target = await createUnit();
  const middle = await createUnit();
  const spare = await createUnit();
  await setSubstitution(actor, { spareId: middle.id, faultyId: target.id });
  await setSubstitution(actor, { spareId: spare.id, faultyId: middle.id });
  return { target, middle, spare };
}

function history(ids: string[]) {
  return db.activityLog.findMany({
    where: { entityType: "equipment", entityId: { in: ids } },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
}

describe("equipment retirement", () => {
  it.each(["outgoing", "incoming", "both", "neither"] as const)(
    "canonical retirement clears %s links and records one retirement audit",
    async (direction) => {
      const { target, middle, spare } = await substitutionChain();
      const retiring =
        direction === "outgoing"
          ? spare
          : direction === "incoming"
            ? target
            : direction === "both"
              ? middle
              : await createUnit();
      const ids = [target.id, middle.id, spare.id, retiring.id];
      const before = await history(ids);

      const retired = await retireEquipment(actor, retiring.id);

      expect(retired.status).toBe("RETIRED");
      expect(retired.substitutingForId).toBeNull();
      expect(await db.equipment.count({ where: { substitutingForId: retiring.id } })).toBe(0);
      expect(await db.equipment.findUniqueOrThrow({ where: { id: middle.id } })).toMatchObject({
        status: direction === "both" ? "RETIRED" : "OPERATIONAL",
        substitutingForId: direction === "incoming" || direction === "both" ? null : target.id,
      });
      expect(await db.equipment.findUniqueOrThrow({ where: { id: spare.id } })).toMatchObject({
        status: direction === "outgoing" ? "RETIRED" : "OPERATIONAL",
        substitutingForId: direction === "outgoing" || direction === "both" ? null : middle.id,
      });
      const after = await history(ids);
      expect(after).toHaveLength(before.length + 1);
      expect(after.filter((log) => !before.some((old) => old.id === log.id))).toEqual([
        expect.objectContaining({
          action: "EquipmentRetired",
          entityId: retiring.id,
          data:
            direction === "incoming" || direction === "both"
              ? { clearedSubstitutionLinks: 1 }
              : null,
        }),
      ]);
    },
  );

  it.each(["outgoing", "incoming", "both"] as const)(
    "editing to RETIRED clears %s links while saving edits with one update audit",
    async (direction) => {
      const { target, middle, spare } = await substitutionChain();
      const equipment = { outgoing: spare, incoming: target, both: middle }[direction];
      const ids = [target.id, middle.id, spare.id];
      const before = await history(ids);
      const input = editInput({
        status: "RETIRED",
        name: "Retired synthetic unit",
        serial: "retired-synthetic-serial",
        hostname: "retired-synthetic-host",
        attributes: '{"retired":true}',
      });

      const retired = await updateEquipment(actor, equipment.id, input);

      expect(retired).toMatchObject({
        status: "RETIRED",
        substitutingForId: null,
        name: input.name,
        serial: input.serial,
        hostname: input.hostname,
        attributes: { retired: true },
      });
      expect(await db.equipment.findUniqueOrThrow({ where: { id: equipment.id } })).toEqual(
        retired,
      );
      expect(await db.equipment.count({ where: { substitutingForId: equipment.id } })).toBe(0);
      expect(await db.equipment.findUniqueOrThrow({ where: { id: middle.id } })).toMatchObject({
        status: direction === "both" ? "RETIRED" : "OPERATIONAL",
        substitutingForId: direction === "outgoing" ? target.id : null,
      });
      expect(await db.equipment.findUniqueOrThrow({ where: { id: spare.id } })).toMatchObject({
        status: direction === "outgoing" ? "RETIRED" : "OPERATIONAL",
        substitutingForId: direction === "incoming" ? middle.id : null,
      });
      const after = await history(ids);
      expect(after).toHaveLength(before.length + 1);
      expect(after.filter((log) => !before.some((old) => old.id === log.id))).toEqual([
        expect.objectContaining({
          action: "EquipmentUpdated",
          entityId: equipment.id,
          data: direction === "outgoing" ? null : { clearedSubstitutionLinks: 1 },
        }),
      ]);
    },
  );

  it.each(["OPERATIONAL", "FAULTY", "MAINTENANCE"] as const)(
    "editing to %s preserves both substitution directions and input semantics",
    async (status) => {
      const { target, middle, spare } = await substitutionChain();
      const input = editInput({
        status,
        name: "Updated synthetic unit",
        mobility: "FIXED",
        roomId,
        serial: "synthetic-serial",
        attributes: '{"synthetic":true}',
      });
      const before = await history([target.id, middle.id, spare.id]);

      const updated = await updateEquipment(actor, middle.id, input);

      expect(updated).toMatchObject({
        status,
        name: input.name,
        roomId,
        serial: input.serial,
        attributes: { synthetic: true },
        substitutingForId: target.id,
      });
      expect(await db.equipment.findUniqueOrThrow({ where: { id: spare.id } })).toMatchObject({
        substitutingForId: middle.id,
      });
      const after = await history([target.id, middle.id, spare.id]);
      expect(after).toHaveLength(before.length + 1);
      expect(after.filter((log) => log.action === "EquipmentUpdated")).toEqual([
        expect.objectContaining({ entityId: middle.id, data: null }),
      ]);
    },
  );

  it.each(["OPERATIONAL", "FAULTY", "MAINTENANCE"] as const)(
    "restores a retired unit to %s without restoring old links",
    async (status) => {
      const { middle, spare } = await substitutionChain();
      await retireEquipment(actor, middle.id);

      const restored = await updateEquipment(actor, middle.id, editInput({ status }));

      expect(restored).toMatchObject({ status, substitutingForId: null });
      expect(await db.equipment.findUniqueOrThrow({ where: { id: spare.id } })).toMatchObject({
        substitutingForId: null,
      });
      expect((await history([middle.id])).map((log) => log.action)).toEqual([
        "EquipmentCreated",
        "EquipmentSubstitutionSet",
        "EquipmentRetired",
        "EquipmentUpdated",
      ]);
    },
  );

  it.each(["retire", "edit"] as const)(
    "%s retains allocations and room bookings and still audits repeated retirement",
    async (path) => {
      const equipment = await createUnit();
      const startsAt = new Date("2038-05-01T10:00:00Z");
      const endsAt = new Date("2038-05-01T11:00:00Z");
      const event = await db.event.create({
        data: { title: `${RUN} ${path}`, startsAt, endsAt },
      });
      eventIds.push(event.id);
      const allocation = await db.equipmentAllocation.create({
        data: { eventId: event.id, equipmentId: equipment.id, startsAt, endsAt },
      });
      const booking = await db.eventRoomBooking.create({
        data: { eventId: event.id, roomId, startsAt, endsAt },
      });

      for (let i = 0; i < 2; i++) {
        const retired =
          path === "retire"
            ? await retireEquipment(actor, equipment.id)
            : await updateEquipment(actor, equipment.id, editInput({ status: "RETIRED" }));
        expect(retired).toMatchObject({ status: "RETIRED", substitutingForId: null });
      }

      expect(await db.equipmentAllocation.findUnique({ where: { id: allocation.id } })).toEqual(
        allocation,
      );
      expect(await db.eventRoomBooking.findUnique({ where: { id: booking.id } })).toEqual(booking);
      expect(await history([equipment.id])).toEqual([
        expect.objectContaining({ action: "EquipmentCreated" }),
        ...Array.from({ length: 2 }, () =>
          expect.objectContaining({
            action: path === "retire" ? "EquipmentRetired" : "EquipmentUpdated",
            data: null,
          }),
        ),
      ]);
      await db.eventRoomBooking.delete({ where: { id: booking.id } });
    },
  );

  it.each(["retire", "edit"] as const)(
    "%s rolls back status, edits, both links and audit after an audit failure",
    async (path) => {
      const { target, middle, spare } = await substitutionChain();
      const ids = [target.id, middle.id, spare.id];
      const before = await db.equipment.findMany({
        where: { id: { in: ids } },
        orderBy: { id: "asc" },
      });
      const logsBefore = await history(ids);
      const failure = new Error("Synthetic failure after audit insert");
      const txWithAudit = auditServer.txWithAudit;
      vi.spyOn(auditServer, "txWithAudit").mockImplementationOnce((actor, fn, options) =>
        txWithAudit(
          actor,
          (tx, audit) =>
            fn(tx, async (input) => {
              await audit(input);
              throw failure;
            }),
          options,
        ),
      );

      await expect(
        path === "retire"
          ? retireEquipment(actor, middle.id)
          : updateEquipment(
              actor,
              middle.id,
              editInput({ status: "RETIRED", name: "Must roll back" }),
            ),
      ).rejects.toThrow(failure);
      vi.restoreAllMocks();

      expect(
        await db.equipment.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } }),
      ).toEqual(before);
      expect(await history(ids)).toEqual(logsBefore);
    },
  );
});
