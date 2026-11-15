import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { hasSqlState } from "~/lib/errors.server";
import {
  connectEquipmentPorts,
  disconnectEquipmentPorts,
} from "../inventory.connections.mutations.server";
import { mutateEquipmentPort } from "../inventory.ports.mutations.server";
import { retireEquipment } from "../inventory.mutations.server";
import { getEquipment } from "../inventory.queries.server";
import {
  freeConnectionPorts,
  listConnectionTargets,
} from "../inventory.connections.queries.server";

const prefix = `connections-${Date.now()}`;
const ids: string[] = [];
const rooms: string[] = [];
const actor = { id: null, name: "Synthetic connection tester" };
const fields = {
  connector: "HDMI" as const,
  direction: "INPUT" as const,
  signal: "VIDEO" as const,
  position: 0,
};
async function fixture() {
  const units = [];
  const ports = [];
  for (let index = 0; index < 3; index++) {
    const unit = await db.equipment.create({
      data: {
        name: `${prefix} Synthetic ${index}-${ids.length}`,
        category: "OTHER",
        mobility: "POOLED",
      },
    });
    ids.push(unit.id);
    units.push(unit);
    ports.push(
      await db.equipmentPort.create({
        data: { ...fields, equipmentId: unit.id, label: index ? "HDMI IN" : "HDMI OUT" },
      }),
    );
  }
  return { units, ports };
}
afterAll(async () => {
  await db.equipmentConnection.deleteMany({
    where: { ends: { some: { equipmentId: { in: ids } } } },
  });
  await db.equipment.deleteMany({ where: { id: { in: ids } } });
  await db.room.deleteMany({ where: { id: { in: rooms } } });
  await db.$disconnect();
});

describe("equipment connections", () => {
  it("shows the same connection at both ends, records both histories and preserves retirement", async () => {
    const { units, ports } = await fixture();
    const connection = await connectEquipmentPorts(actor, {
      equipmentId: units[0].id,
      portId: ports[0].id,
      targetEquipmentId: units[1].id,
      targetPortId: ports[1].id,
      note: "Synthetic cable route",
    });
    const source = (await getEquipment(units[0].id))!.ports[0];
    expect(source.connection).toMatchObject({
      id: connection.id,
      note: "Synthetic cable route",
      other: { id: ports[1].id },
    });
    expect(source.allowedActions.find((action) => action.target === "CONNECT")?.allowed).toBe(
      false,
    );
    expect((await getEquipment(units[1].id))!.ports[0].connection?.other.id).toBe(ports[0].id);
    expect(
      await db.activityLog.count({
        where: { action: "EquipmentPortsConnected", entityId: { in: [units[0].id, units[1].id] } },
      }),
    ).toBe(2);
    await expect(
      mutateEquipmentPort(actor, units[0].id, "remove", undefined, ports[0].id),
    ).rejects.toMatchObject({ formErrors: [expect.stringMatching(/Synthetic 1.*HDMI IN/)] });
    await retireEquipment(actor, units[1].id);
    expect((await getEquipment(units[0].id))!.ports[0].connection?.other.equipment.status).toBe(
      "RETIRED",
    );
    await disconnectEquipmentPorts(actor, units[1].id, connection.id);
    expect((await getEquipment(units[0].id))!.ports[0].connection).toBeNull();
    expect((await getEquipment(units[1].id))!.ports).toHaveLength(1);
    expect(
      await db.activityLog.count({
        where: {
          action: "EquipmentPortsDisconnected",
          entityId: { in: [units[0].id, units[1].id] },
        },
      }),
    ).toBe(2);
  });

  it("atomically creates a target port and permits descriptive signal/direction mismatches", async () => {
    const { units, ports } = await fixture();
    await connectEquipmentPorts(actor, {
      equipmentId: units[0].id,
      portId: ports[0].id,
      targetEquipmentId: units[1].id,
      newPort: {
        label: "Power",
        connector: "DC_POWER",
        direction: "INPUT",
        signal: "POWER",
        position: 1,
        note: "Synthetic adapter",
      },
    });
    expect((await getEquipment(units[1].id))!.ports[1]).toMatchObject({
      label: "Power",
      note: "Synthetic adapter",
      connection: { other: { id: ports[0].id } },
    });
    await expect(
      connectEquipmentPorts(actor, {
        equipmentId: units[0].id,
        portId: ports[0].id,
        targetEquipmentId: units[2].id,
        newPort: { ...fields, label: "Must not remain" },
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(
      await db.equipmentPort.count({
        where: { equipmentId: units[2].id, label: "Must not remain" },
      }),
    ).toBe(0);
  });

  it("scopes port IDs to their device and refuses connections to the same device", async () => {
    const { units, ports } = await fixture();
    await expect(
      connectEquipmentPorts(actor, {
        equipmentId: units[0].id,
        portId: ports[1].id,
        targetEquipmentId: units[2].id,
        targetPortId: ports[2].id,
      }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(
      connectEquipmentPorts(actor, {
        equipmentId: units[0].id,
        portId: ports[0].id,
        targetEquipmentId: units[0].id,
        targetPortId: ports[0].id,
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    const connection = await connectEquipmentPorts(actor, {
      equipmentId: units[0].id,
      portId: ports[0].id,
      targetEquipmentId: units[1].id,
      targetPortId: ports[1].id,
    });
    await expect(disconnectEquipmentPorts(actor, units[2].id, connection.id)).rejects.toMatchObject(
      { name: "NotFoundError" },
    );
    expect((await freeConnectionPorts(units[2].id, units[1].id)).ports).toHaveLength(0);
  });

  it("admits only one concurrent connection and leaves no orphan target ports", async () => {
    const { units, ports } = await fixture();
    const outcomes = await Promise.allSettled(
      [1, 2].map((index) =>
        connectEquipmentPorts(actor, {
          equipmentId: units[0].id,
          portId: ports[0].id,
          targetEquipmentId: units[index].id,
          newPort: { ...fields, label: "Concurrent target" },
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.equipmentPort.count({
        where: { equipmentId: { in: units.map((unit) => unit.id) }, label: "Concurrent target" },
      }),
    ).toBe(1);
  });

  for (const count of [0, 1, 3])
    it(`PostgreSQL rejects a connection with ${count} ends at commit`, async () => {
      const { ports } = await fixture();
      let failure: unknown;
      try {
        await txWithAudit(actor, async (tx) => {
          const connection = await tx.equipmentConnection.create({ data: {} });
          for (const port of ports.slice(0, count))
            await tx.equipmentConnectionEnd.create({
              data: { connectionId: connection.id, portId: port.id, equipmentId: port.equipmentId },
            });
        });
      } catch (error) {
        failure = error;
      }
      expect(hasSqlState(failure, "23514")).toBe(true);
    });

  it("enforces exclusive ports, distinct devices and truthful port ownership in PostgreSQL", async () => {
    const { units, ports } = await fixture();
    const extra = await db.equipmentPort.create({
      data: { ...fields, equipmentId: units[0].id, label: "Extra" },
    });
    await expect(
      db.equipmentConnection.create({
        data: {
          ends: {
            create: [ports[0], extra].map((port) => ({
              portId: port.id,
              equipmentId: port.equipmentId,
            })),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      txWithAudit(actor, async (tx) => {
        const connection = await tx.equipmentConnection.create({ data: {} });
        await tx.equipmentConnectionEnd.create({
          data: { connectionId: connection.id, portId: ports[0].id, equipmentId: units[1].id },
        });
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await connectEquipmentPorts(actor, {
      equipmentId: units[0].id,
      portId: ports[0].id,
      targetEquipmentId: units[1].id,
      targetPortId: ports[1].id,
    });
    await expect(db.equipmentPort.delete({ where: { id: ports[0].id } })).rejects.toMatchObject({
      code: "P2003",
    });
    await expect(
      db.equipmentPort.update({ where: { id: ports[0].id }, data: { equipmentId: units[2].id } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.equipmentConnection.create({
        data: {
          ends: {
            create: [ports[0], ports[2]].map((port) => ({
              portId: port.id,
              equipmentId: port.equipmentId,
            })),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects endpoint deletion, reassignment and hard deletion of connected devices", async () => {
    const { units, ports } = await fixture();
    const connection = await connectEquipmentPorts(actor, {
      equipmentId: units[0].id,
      portId: ports[0].id,
      targetEquipmentId: units[1].id,
      targetPortId: ports[1].id,
    });
    for (const all of [false, true]) {
      let failure: unknown;
      try {
        await db.equipmentConnectionEnd.deleteMany({
          where: all ? { connectionId: connection.id } : { portId: ports[0].id },
        });
      } catch (error) {
        failure = error;
      }
      expect(hasSqlState(failure, "23514")).toBe(true);
    }
    let failure: unknown;
    try {
      await txWithAudit(actor, async (tx) => {
        const other = await tx.equipmentConnection.create({ data: {} });
        await tx.equipmentConnectionEnd.update({
          where: { portId: ports[0].id },
          data: { connectionId: other.id },
        });
      });
    } catch (error) {
      failure = error;
    }
    expect(hasSqlState(failure, "23514")).toBe(true);
    await expect(db.equipment.delete({ where: { id: units[0].id } })).rejects.toMatchObject({
      code: "P2003",
    });
    expect(await db.equipmentConnectionEnd.count({ where: { connectionId: connection.id } })).toBe(
      2,
    );
  });

  it("puts same-room devices before alphabetical matches elsewhere", async () => {
    const { units } = await fixture();
    const room = await db.room.create({
      data: { name: "Synthetic connection room", slug: `${prefix}-${rooms.length}` },
    });
    rooms.push(room.id);
    await db.equipment.update({ where: { id: units[0].id }, data: { roomId: room.id } });
    await db.equipment.update({
      where: { id: units[1].id },
      data: { roomId: room.id, name: `${prefix}-sort Z nearby` },
    });
    await db.equipment.update({
      where: { id: units[2].id },
      data: { name: `${prefix}-sort A elsewhere` },
    });
    expect(
      (await listConnectionTargets(units[0].id, `${prefix}-sort`)).map((unit) => unit.id),
    ).toEqual([units[1].id, units[2].id]);
  });
});
