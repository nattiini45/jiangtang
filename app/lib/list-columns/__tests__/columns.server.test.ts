import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { Prisma } from "~/generated/prisma/client";
import { getListColumns, saveListColumns, withListValues } from "../columns.server";
import { DEFAULT_COLUMNS, fieldColumnId } from "../columns";
import { listRooms } from "~/domains/rooms/rooms.queries.server";

const fieldIds: string[] = [],
  roomIds: string[] = [],
  campusIds: string[] = [];
afterEach(async () => {
  await db.listColumns.deleteMany();
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds.splice(0) } } });
  await db.campus.deleteMany({ where: { id: { in: campusIds.splice(0) } } });
  await db.customField.deleteMany({ where: { id: { in: fieldIds.splice(0) } } });
});

it("reads the default and skips archived/deleted definitions, then drops them in the audited save", async () => {
  expect((await getListColumns("ROOM", false)).columns).toEqual(DEFAULT_COLUMNS.ROOM);
  const active = await db.customField.create({
    data: {
      scope: "ROOM",
      key: `f_${randomUUID().replaceAll("-", "")}`,
      name: randomUUID(),
      type: "NUMBER",
    },
  });
  const archived = await db.customField.create({
    data: {
      scope: "ROOM",
      key: `f_${randomUUID().replaceAll("-", "")}`,
      name: randomUUID(),
      type: "TEXT",
      archivedAt: new Date(),
    },
  });
  fieldIds.push(active.id, archived.id);
  const input = ["name", fieldColumnId(archived.id), "field:deleted", fieldColumnId(active.id)];
  await db.listColumns.create({ data: { scope: "ROOM", columns: input } });
  const config = await getListColumns("ROOM", false);
  expect(config.columns).toEqual(["name", fieldColumnId(active.id)]);
  expect(config.fields.map((field) => field.id)).toEqual([active.id]);
  await saveListColumns({ name: "Synthetic administrator" }, "ROOM", input);
  expect((await db.listColumns.findUniqueOrThrow({ where: { scope: "ROOM" } })).columns).toEqual(
    config.columns,
  );
  const audit = await db.activityLog.findFirstOrThrow({
    where: { action: "ListColumnsChanged", entityId: "ROOM" },
    orderBy: { occurredAt: "desc" },
  });
  expect(audit.data).toEqual({ before: input, after: config.columns });
  await expect(
    saveListColumns({ name: "Synthetic administrator" }, "ROOM", ["capacity", "name"]),
  ).rejects.toThrow();
  await expect(
    saveListColumns({ name: "Synthetic administrator" }, "ROOM", [
      "name",
      ...Array.from({ length: 12 }, (_, i) => `field:${i}`),
    ]),
  ).rejects.toThrow();
  expect((await db.listColumns.findUniqueOrThrow({ where: { scope: "ROOM" } })).columns).toEqual(
    config.columns,
  );
});

it("projects only chosen values and blanks properties that do not apply to the device kind", async () => {
  const kinds = await db.equipmentKind.findMany({ take: 2 });
  const field = await db.customField.create({
    data: {
      scope: "EQUIPMENT",
      key: `f_${randomUUID().replaceAll("-", "")}`,
      name: randomUUID(),
      type: "TEXT",
      kinds: { create: { kindId: kinds[0].id } },
    },
  });
  fieldIds.push(field.id);
  const room = await db.room.create({
    data: { name: "Synthetic projection room", slug: randomUUID() },
  });
  roomIds.push(room.id);
  const devices = await Promise.all(
    kinds.map((kind) =>
      db.equipment.create({
        data: {
          roomId: room.id,
          kindId: kind.id,
          category: "OTHER",
          customValues: { [field.id]: "Visible value", unselected: "Do not send" },
        },
      }),
    ),
  );
  const rows = await withListValues(
    "EQUIPMENT",
    devices.map((device) => ({ id: device.id, kind: { id: device.kindId! } })),
    ["name", fieldColumnId(field.id)],
  );
  expect(rows[0].values).toEqual({ [field.id]: "Visible value" });
  expect(rows[1].values).toEqual({});
  expect(JSON.stringify(rows)).not.toContain("Do not send");
  expect(
    (await withListValues("EQUIPMENT", rows, ["name"])).every(
      (row) => !Object.keys(row.values).length,
    ),
  ).toBe(true);
});

it("rejects invalid column arrays in PostgreSQL and rolls a save back when auditing fails", async () => {
  const arrays = [
    Prisma.sql`ARRAY[]::text[]`,
    Prisma.sql`ARRAY['capacity']`,
    Prisma.sql`ARRAY['name', NULL]`,
    Prisma.sql`ARRAY[['name', 'capacity']]`,
    Prisma.sql`ARRAY['name'] || array_fill('capacity'::text, ARRAY[12])`,
  ];
  for (const columns of arrays) {
    await expect(
      db.$executeRaw(
        Prisma.sql`INSERT INTO "ListColumns" (scope, columns, "updatedAt") VALUES ('ROOM', ${columns}, now())`,
      ),
    ).rejects.toThrow();
  }
  expect(await db.listColumns.count()).toBe(0);
  await expect(
    saveListColumns({ name: "Synthetic\u0000administrator" }, "ROOM", ["name", "capacity"]),
  ).rejects.toThrow();
  expect(await db.listColumns.count()).toBe(0);
});

it("combines device-kind, campus, status and text predicates on real rooms without duplicate rooms", async () => {
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  const campus = await db.campus.create({ data: { name: randomUUID(), slug: randomUUID() } });
  campusIds.push(campus.id);
  for (let i = 0; i < 3; i++) {
    const room = await db.room.create({
      data: {
        name: `Synthetic kind filter ${i}`,
        slug: randomUUID(),
        campusId: campus.id,
        status: i === 2 ? "MAINTENANCE_NEEDED" : "ALL_GOOD",
      },
    });
    roomIds.push(room.id);
    if (i !== 1)
      await db.equipment.createMany({
        data: Array.from({ length: 2 }, () => ({
          roomId: room.id,
          kindId: kind.id,
          category: "PROJECTOR" as const,
        })),
      });
  }
  const rooms = await listRooms({
    kindId: kind.id,
    campusId: campus.id,
    status: "ALL_GOOD",
    q: "Synthetic kind filter",
  });
  expect(rooms.map((room) => room.id)).toEqual([roomIds[0]]);
});
