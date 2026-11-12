import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { createEquipment, updateEquipment } from "~/domains/inventory/inventory.mutations.server";
import { equipmentCreateSchema } from "~/domains/inventory/inventory.schema";
import { createRoom, updateRoom } from "~/domains/rooms/rooms.mutations.server";
import { roomCreateSchema } from "~/domains/rooms/rooms.schema";
import { setRoomCustomValues } from "~/domains/rooms/rooms.custom-values.server";
import { setEquipmentCustomValues } from "~/domains/inventory/inventory.custom-values.server";
import {
  createCustomField,
  updateCustomField,
  updateFieldOptions,
  deleteCustomField,
} from "../definitions.server";
import { CustomValuesError, withCustomValues, validateCustomValues } from "../values.server";
import type { CustomFieldType, CustomFieldScope } from "~/generated/prisma/client";
import { createFieldSchema, fieldOptionsSchema } from "../definitions.schema";

const actor = { name: "Synthetic field editor" };
const fieldIds: string[] = [],
  roomIds: string[] = [],
  equipmentIds: string[] = [];
afterEach(async () => {
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds.splice(0) } } });
  await db.room.deleteMany({ where: { id: { in: roomIds.splice(0) } } });
  await db.customField.deleteMany({ where: { id: { in: fieldIds.splice(0) } } });
});
async function field(
  type: CustomFieldType,
  scope: CustomFieldScope = "ROOM",
  kindIds: string[] = [],
) {
  const key = `f_${randomUUID().replaceAll("-", "")}`;
  const result = await createCustomField(actor, { key, name: key, scope, type, kindIds });
  fieldIds.push(result.id);
  return result;
}
async function room(values?: Record<string, unknown>) {
  const result = await createRoom(
    actor,
    roomCreateSchema.parse({ name: randomUUID(), customValues: values }),
  );
  roomIds.push(result.id);
  return result;
}
async function equipment(kindId?: string, values?: Record<string, unknown>) {
  const result = await createEquipment(actor, {
    ...equipmentCreateSchema.parse({
      category: "PROJECTOR",
      mobility: "POOLED",
      customValues: values,
    }),
    ...(kindId ? { kindId } : {}),
  });
  equipmentIds.push(result.id);
  return result;
}

describe("custom field values", () => {
  it("merges supplied updates and validates device values against the newly selected kind", async () => {
    const kinds = await db.equipmentKind.findMany({ take: 2 });
    const original = await field("TEXT", "EQUIPMENT", [kinds[0].id]);
    const target = await field("NUMBER", "EQUIPMENT", [kinds[1].id]);
    const device = await equipment(kinds[0].id, { [original.key]: "Keep" });
    const input = {
      ...equipmentCreateSchema.parse({ category: "OTHER", mobility: "POOLED" }),
      kindId: kinds[1].id,
    };
    await expect(
      updateEquipment(actor, device.id, { ...input, customValues: { [original.key]: "Reject" } }),
    ).rejects.toBeInstanceOf(CustomValuesError);
    expect((await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).kindId).toBe(
      kinds[0].id,
    );
    await updateEquipment(actor, device.id, { ...input, customValues: { [target.key]: 12 } });
    expect(
      (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).customValues,
    ).toEqual({ [original.id]: "Keep", [target.id]: 12 });
    const text = await field("TEXT"),
      flag = await field("BOOLEAN");
    const place = await room({ [text.key]: "Before", [flag.key]: false });
    await updateRoom(
      actor,
      place.id,
      roomCreateSchema.parse({ name: "After", customValues: { [text.key]: "After" } }),
    );
    expect((await db.room.findUniqueOrThrow({ where: { id: place.id } })).customValues).toEqual({
      [text.id]: "After",
      [flag.id]: false,
    });
  });
  it("rejects NUL and malformed Unicode before PostgreSQL sees strings", async () => {
    const f = await field("TEXT");
    const place = await room();
    for (const value of ["\u0000", "\ud800", "\udfff"]) {
      await expect(setRoomCustomValues(actor, place.id, { [f.key]: value })).rejects.toBeInstanceOf(
        CustomValuesError,
      );
      expect(
        createFieldSchema.safeParse({ key: "test", name: value, scope: "ROOM", type: "TEXT" })
          .success,
      ).toBe(false);
      expect(
        fieldOptionsSchema.safeParse({ fieldId: f.id, changes: [{ op: "add", label: value }] })
          .success,
      ).toBe(false);
    }
    expect((await db.room.findUniqueOrThrow({ where: { id: place.id } })).customValues).toEqual({});
  });

  it("serializes a deletion against a concurrent value writer", async () => {
    const f = await field("TEXT");
    const place = await room();
    const outcomes = await Promise.allSettled([
      setRoomCustomValues(actor, place.id, { [f.key]: "Retain" }),
      deleteCustomField(actor, f.id),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const exists = await db.customField.findUnique({ where: { id: f.id } });
    const stored = (await db.room.findUniqueOrThrow({ where: { id: place.id } })).customValues;
    expect(Object.hasOwn(stored as object, f.id)).toBe(Boolean(exists));
  });
  it("counts archived fields and retired options toward the total limits", async () => {
    const existing = await db.customField.count({ where: { scope: "EQUIPMENT" } });
    const rows = Array.from({ length: 120 - existing }, () => ({
      id: randomUUID(),
      key: `f_${randomUUID().replaceAll("-", "")}`,
      name: randomUUID(),
      type: "TEXT" as const,
      scope: "EQUIPMENT" as const,
      archivedAt: new Date(),
    }));
    await db.customField.createMany({ data: rows });
    fieldIds.push(...rows.map((row) => row.id));
    await expect(field("TEXT", "EQUIPMENT")).rejects.toMatchObject({
      fieldErrors: { scope: [expect.stringContaining("120")] },
    });
    const f = await field("CHOICE");
    await db.customFieldOption.createMany({
      data: Array.from({ length: 200 }, (_, index) => ({
        fieldId: f.id,
        label: `Retired ${index}`,
        archivedAt: new Date(),
      })),
    });
    await expect(
      updateFieldOptions(actor, { fieldId: f.id, changes: [{ op: "add", label: "Overflow" }] }),
    ).rejects.toMatchObject({ fieldErrors: { changes: [expect.stringContaining("200")] } });
    expect(await db.customFieldOption.count({ where: { fieldId: f.id } })).toBe(200);
    expect(
      await db.activityLog.count({
        where: { entityId: f.id, action: "CustomFieldOptionsChanged" },
      }),
    ).toBe(0);
  });
  it("converts only compatible types and refuses to discard a multiple selection", async () => {
    const f = await field("CHOICE");
    const options = await updateFieldOptions(actor, {
      fieldId: f.id,
      changes: [
        { op: "add", label: "A" },
        { op: "add", label: "B" },
      ],
    });
    const place = await room({ [f.key]: "A" });
    await updateCustomField(actor, { id: f.id, type: "MULTI_CHOICE" });
    expect((await db.room.findUniqueOrThrow({ where: { id: place.id } })).customValues).toEqual({
      [f.id]: [options.options.find((option) => option.label === "A")!.id],
    });
    await setRoomCustomValues(actor, place.id, { [f.key]: ["A", "B"] });
    await expect(updateCustomField(actor, { id: f.id, type: "CHOICE" })).rejects.toMatchObject({
      fieldErrors: { type: [expect.any(String)] },
    });
    await setRoomCustomValues(actor, place.id, { [f.key]: ["B"] });
    await updateCustomField(actor, { id: f.id, type: "CHOICE" });
    expect((await withCustomValues("ROOM", [place]))[0].customValues[f.key]).toBe("B");
    await expect(updateCustomField(actor, { id: f.id, type: "NUMBER" })).rejects.toMatchObject({
      fieldErrors: { type: [expect.any(String)] },
    });
    const text = await field("TEXT");
    await updateCustomField(actor, { id: text.id, type: "LONG_TEXT" });
    await setRoomCustomValues(actor, place.id, { [text.key]: "x".repeat(300) });
  });
  it("stores choices as IDs, reads labels and merges concurrent device writers", async () => {
    const projector = await db.equipmentKind.findUniqueOrThrow({
      where: { systemKey: "projector" },
    });
    const hours = await field("NUMBER", "EQUIPMENT", [projector.id]);
    const mark = await field("TEXT", "EQUIPMENT");
    const layout = await field("CHOICE");
    const options = await updateFieldOptions(actor, {
      fieldId: layout.id,
      changes: [{ op: "add", label: "Standing" }],
    });
    const place = await room({ [layout.key]: "standing" });
    expect(place.customValues).toEqual({ [layout.id]: options.options[0].id });
    const device = await equipment(projector.id);
    await Promise.all([
      setEquipmentCustomValues(actor, device.id, { [hours.key]: 123.123456 }),
      setEquipmentCustomValues(actor, device.id, { [mark.key]: "Blue" }),
    ]);
    expect(
      (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).customValues,
    ).toEqual({ [hours.id]: 123.123456, [mark.id]: "Blue" });
    expect((await withCustomValues("ROOM", [place], true))[0]).toMatchObject({
      customValues: { [layout.key]: "Standing" },
      customFields: [expect.objectContaining({ id: layout.id })],
    });
    const before = await db.activityLog.count({ where: { entityId: device.id } });
    await expect(
      setEquipmentCustomValues(actor, device.id, { [hours.key]: "bad", [mark.key]: "Red" }),
    ).rejects.toBeInstanceOf(CustomValuesError);
    expect(await db.activityLog.count({ where: { entityId: device.id } })).toBe(before);
    expect(
      (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).customValues,
    ).toMatchObject({ [mark.id]: "Blue" });
  });

  it("preserves omitted values and hides rather than deletes values after a kind change", async () => {
    const kinds = await db.equipmentKind.findMany({ take: 2 });
    const own = await field("BOOLEAN", "EQUIPMENT", [kinds[0].id]);
    const device = await equipment(kinds[0].id, { [own.key]: false });
    const input = equipmentCreateSchema.parse({ category: "OTHER", mobility: "POOLED" });
    await updateEquipment(actor, device.id, { ...input, kindId: kinds[1].id });
    expect((await withCustomValues("EQUIPMENT", [device]))[0].customValues).toEqual({});
    await expect(
      setEquipmentCustomValues(actor, device.id, { [own.key]: true }),
    ).rejects.toMatchObject({ errors: [{ field: own.key, code: "not_applicable" }] });
    await expect(deleteCustomField(actor, own.id)).rejects.toMatchObject({
      fieldErrors: { id: [expect.any(String)] },
    });
    await updateEquipment(actor, device.id, { ...input, kindId: kinds[0].id });
    await db.equipment.update({
      where: { id: device.id },
      data: { customValues: { [own.id]: false, orphan_id: "ignored" } },
    });
    expect((await withCustomValues("EQUIPMENT", [device]))[0].customValues).toEqual({
      [own.key]: false,
    });
    const text = await field("TEXT");
    const place = await room({ [text.key]: "Preserve" });
    await updateRoom(actor, place.id, roomCreateSchema.parse({ name: "Changed" }));
    expect((await db.room.findUniqueOrThrow({ where: { id: place.id } })).customValues).toEqual({
      [text.id]: "Preserve",
    });
  });

  it("rejects archived and unknown fields and protects stored single and multi options", async () => {
    const choice = await field("CHOICE"),
      multi = await field("MULTI_CHOICE");
    const a = (
      await updateFieldOptions(actor, {
        fieldId: choice.id,
        changes: [{ op: "add", label: "First" }],
      })
    ).options[0];
    const b = (
      await updateFieldOptions(actor, {
        fieldId: multi.id,
        changes: [{ op: "add", label: "Second" }],
      })
    ).options[0];
    const place = await room({ [choice.key]: a.id, [multi.key]: ["SECOND"] });
    for (const [f, option] of [
      [choice, a],
      [multi, b],
    ] as const)
      await expect(
        updateFieldOptions(actor, { fieldId: f.id, changes: [{ op: "delete", id: option.id }] }),
      ).rejects.toMatchObject({ fieldErrors: { changes: [expect.any(String)] } });
    await updateFieldOptions(actor, {
      fieldId: choice.id,
      changes: [{ op: "update", id: a.id, label: "Renamed", archived: true }],
    });
    expect((await withCustomValues("ROOM", [place]))[0].customValues[choice.key]).toContain(
      "Renamed",
    );
    await expect(
      setRoomCustomValues(actor, place.id, { [choice.key]: a.id }),
    ).rejects.toMatchObject({
      errors: [{ field: choice.key, code: "unknown_option", allowed: [] }],
    });
    await updateCustomField(actor, { id: multi.id, archived: true });
    await expect(
      setRoomCustomValues(actor, place.id, { [multi.key]: null, unknown_key: 3 }),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([
        { field: multi.key, code: "archived_field" },
        { field: "unknown_key", code: "unknown_field" },
      ]),
    });
    await updateCustomField(actor, { id: multi.id, archived: false });
    await setRoomCustomValues(actor, place.id, { [choice.key]: null, [multi.key]: null });
    const audit = await db.activityLog.findFirstOrThrow({
      where: { entityId: place.id, action: "RoomUpdated" },
    });
    expect(JSON.stringify(audit.data)).toContain("Renamed");
    expect((await db.room.findUniqueOrThrow({ where: { id: place.id } })).customValues).toEqual({});
    await updateFieldOptions(actor, { fieldId: choice.id, changes: [{ op: "delete", id: a.id }] });
    await deleteCustomField(actor, choice.id);
  });

  it("validates every type, calendar dates, six decimals and text limits in one compiler", async () => {
    const cases: Array<[CustomFieldType, unknown, unknown]> = [
      ["TEXT", "😀".repeat(200), "a".repeat(201)],
      ["LONG_TEXT", "b".repeat(4000), "b".repeat(4001)],
      ["NUMBER", 0.000001, 0.0000001],
      ["BOOLEAN", false, "false"],
      ["DATE", "2024-02-29", "2026-02-29"],
      ["LINK", "https://example.test/manual", "javascript:alert(1)"],
    ];
    const place = await room();
    for (const [type, valid, invalid] of cases) {
      const f = await field(type);
      await setRoomCustomValues(actor, place.id, { [f.key]: valid });
      await expect(
        setRoomCustomValues(actor, place.id, { [f.key]: invalid }),
      ).rejects.toBeInstanceOf(CustomValuesError);
      expect(validateCustomValues([f], { [f.id]: valid }, undefined, "id").set).toEqual({
        [f.id]: valid,
      });
    }
    const multi = await field("MULTI_CHOICE");
    const options = await updateFieldOptions(actor, {
      fieldId: multi.id,
      changes: [{ op: "add", label: "A" }],
    });
    await expect(
      setRoomCustomValues(actor, place.id, { [multi.key]: ["A", options.options[0].id] }),
    ).rejects.toBeInstanceOf(CustomValuesError);
  });

  it("enforces 32 KB both in the shared writer and the database", async () => {
    const fields = [];
    for (let n = 0; n < 9; n++) fields.push(await field("LONG_TEXT"));
    const values = Object.fromEntries(fields.map((f) => [f.key, "x".repeat(4000)]));
    const place = await room();
    await expect(setRoomCustomValues(actor, place.id, values)).rejects.toMatchObject({
      errors: [{ field: "customValues", code: "limit" }],
    });
    expect((await db.room.findUniqueOrThrow({ where: { id: place.id } })).customValues).toEqual({});
    await expect(
      db.room.update({ where: { id: place.id }, data: { customValues: [] } }),
    ).rejects.toThrow();
    await expect(
      db.room.update({
        where: { id: place.id },
        data: { customValues: Object.fromEntries(fields.map((f) => [f.id, "x".repeat(4000)])) },
      }),
    ).rejects.toThrow();
  });

  it("caps the record audit at 20 labeled entries and 200 characters without truncating data", async () => {
    const values: Record<string, string> = {};
    for (let n = 0; n < 21; n++) values[(await field("LONG_TEXT")).key] = "x".repeat(220);
    const place = await room();
    await setRoomCustomValues(actor, place.id, values);
    const logs = await db.activityLog.findMany({
      where: { entityId: place.id, action: "RoomUpdated" },
    });
    expect(logs).toHaveLength(1);
    const data = logs[0].data as {
      custom: { key: string; name: string; from: null; to: string }[];
      customMore: number;
    };
    expect(data.custom).toHaveLength(20);
    expect(data.customMore).toBe(1);
    expect(
      data.custom.every(
        (entry) => entry.name && entry.key && entry.from === null && entry.to.length === 200,
      ),
    ).toBe(true);
    expect(
      Object.values((await withCustomValues("ROOM", [place]))[0].customValues).every(
        (value) => String(value).length === 220,
      ),
    ).toBe(true);
  });
});
