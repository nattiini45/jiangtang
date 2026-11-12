import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { deriveFieldKey, previewOptions } from "../admin";
import { moveCustomField } from "../admin.server";
import {
  createCustomField,
  createNamedCustomField,
  deleteCustomField,
  getDefinitions,
  getRecordSchema,
  updateCustomField,
  updateFieldOptions,
} from "../definitions.server";
import { updateDeviceKind } from "~/lib/equipment-kinds/structure.server";
import { fieldGroups } from "../fields";
import { valuesFromForm } from "../form.server";
import { runWithLocale } from "~/i18n/request-locale.server";

const actor = { name: "Synthetic administrator" };
const fieldIds: string[] = [],
  kindIds: string[] = [],
  roomIds: string[] = [],
  equipmentIds: string[] = [];
afterEach(async () => {
  const equipment = equipmentIds.splice(0);
  await db.searchIndexJob.deleteMany({ where: { sourceId: { in: equipment } } });
  await db.chunk.deleteMany({ where: { sourceId: { in: equipment } } });
  await db.equipment.deleteMany({ where: { id: { in: equipment } } });
  await db.room.deleteMany({ where: { id: { in: roomIds.splice(0) } } });
  await db.customField.deleteMany({ where: { id: { in: fieldIds.splice(0) } } });
  await db.equipmentKind.deleteMany({ where: { id: { in: kindIds.splice(0) } } });
});
async function kind() {
  const group = await db.equipmentFunctionGroup.findFirstOrThrow({ where: { archivedAt: null } });
  const row = await db.equipmentKind.create({
    data: { name: randomUUID(), groupId: group.id, position: 0 },
  });
  kindIds.push(row.id);
  return row;
}
async function field(extra: Partial<Parameters<typeof createCustomField>[1]> = {}) {
  const row = await createCustomField(actor, {
    scope: "EQUIPMENT",
    key: `f_${randomUUID().replaceAll("-", "")}`,
    name: randomUUID(),
    type: "TEXT",
    ...extra,
  });
  fieldIds.push(row.id);
  return row;
}

describe("field administration", () => {
  it("derives immutable ASCII keys with collision suffixes under the definitions lock", async () => {
    expect(deriveFieldKey("Äußere Größe", [])).toBe("aeussere_groesse");
    expect(deriveFieldKey("123 / 測定", [])).toBe("field_123");
    expect(deriveFieldKey("測定", [])).toBe("field_");
    expect(deriveFieldKey("A".repeat(80), ["a".repeat(40)])).toBe(`${"a".repeat(38)}_2`);
    const [a, b] = await Promise.all([kind(), kind()]);
    const name = `Ä ${randomUUID()}`;
    const rows = await Promise.all(
      [a, b].map((kind) =>
        createNamedCustomField(actor, {
          scope: "EQUIPMENT",
          type: "TEXT",
          name,
          kindIds: [kind.id],
        }),
      ),
    );
    fieldIds.push(...rows.map((row) => row.id));
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    const renamed = await updateCustomField(actor, { id: rows[0].id, name: randomUUID() });
    expect(renamed.key).toBe(rows[0].key);
  });

  it("moves a visible field within its section and a whole section atomically", async () => {
    const a = await kind(),
      b = await kind();
    const first = await field({ section: "First", position: 10, kindIds: [a.id] });
    const hidden = await field({ section: "First", position: 11, kindIds: [b.id] });
    const last = await field({ section: "First", position: 12, kindIds: [a.id] });
    const other = await field({ section: "Second", position: 13, kindIds: [a.id] });
    await moveCustomField(actor, { id: last.id, direction: "up", section: false, kindId: a.id });
    let groups = fieldGroups(
      (await getDefinitions("EQUIPMENT")).filter((row) => fieldIds.includes(row.id)),
    );
    expect(groups[0].fields.map((row) => row.id)).toEqual([last.id, hidden.id, first.id]);
    await moveCustomField(actor, { id: other.id, direction: "up", section: true, kindId: a.id });
    groups = fieldGroups(
      (await getDefinitions("EQUIPMENT")).filter((row) => fieldIds.includes(row.id)),
    );
    expect(groups.map((group) => group.section)).toEqual(["Second", "First"]);
    expect(groups[1].fields.map((row) => row.id)).toEqual([last.id, hidden.id, first.id]);
    const logs = await db.activityLog.findMany({
      where: { entityId: { in: [last.id, other.id] }, action: "CustomFieldUpdated" },
    });
    expect(logs).toHaveLength(2);
  });

  it("moves sections in the selected kind's order even when another kind has an earlier field", async () => {
    const a = await kind(),
      b = await kind();
    const hidden = await field({ section: "Later", position: 0, kindIds: [b.id] });
    const other = await field({ section: "Earlier", position: 1, kindIds: [a.id] });
    const first = await field({ section: "Later", position: 2, kindIds: [a.id] });
    const last = await field({ section: "Later", position: 3, kindIds: [a.id] });
    await moveCustomField(actor, { id: last.id, direction: "up", section: false, kindId: a.id });
    expect((await db.customField.findUniqueOrThrow({ where: { id: other.id } })).position).toBe(1);
    await moveCustomField(actor, { id: last.id, direction: "up", section: true, kindId: a.id });
    const definitions = (await getDefinitions("EQUIPMENT")).filter((row) =>
      fieldIds.includes(row.id),
    );
    expect(
      fieldGroups(definitions.filter((row) => row.kinds.some((link) => link.kindId === a.id))).map(
        (group) => group.section,
      ),
    ).toEqual(["Later", "Earlier"]);
    expect(fieldGroups(definitions)[0].fields.map((row) => row.id)).toEqual([
      hidden.id,
      last.id,
      first.id,
    ]);
  });

  it("previews repeats and limits, then appends an atomic batch in pasted order", async () => {
    const choice = await field({ type: "CHOICE" });
    let updated = await updateFieldOptions(actor, {
      fieldId: choice.id,
      changes: [{ op: "add", label: "Old", position: 90 }],
    });
    const preview = previewOptions("New\nOld\nNEW\nLast", updated.options);
    expect(preview.map((row) => row.status)).toEqual(["new", "repeat", "repeat", "new"]);
    updated = await updateFieldOptions(
      actor,
      {
        fieldId: choice.id,
        changes: preview
          .filter((row) => row.status === "new")
          .map((row) => ({ op: "add", label: row.label, position: 0 })),
      },
      true,
    );
    expect(updated.options.map((option) => option.label)).toEqual(["Old", "New", "Last"]);
    await expect(
      updateFieldOptions(
        actor,
        {
          fieldId: choice.id,
          changes: [
            { op: "add", label: "Rollback" },
            { op: "add", label: "Old" },
          ],
        },
        true,
      ),
    ).rejects.toThrow();
    expect(await db.customFieldOption.count({ where: { fieldId: choice.id } })).toBe(3);
    const options = Array.from({ length: 49 }, (_, index) => ({
      label: `Option ${index}`,
      archivedAt: null,
    }));
    expect(previewOptions("One\nTwo\nOne", options).map((row) => row.status)).toEqual([
      "new",
      "limit",
      "repeat",
    ]);
    expect(
      previewOptions(
        "New",
        Array.from({ length: 200 }, (_, index) => ({
          label: String(index),
          archivedAt: new Date(),
        })),
      )[0].status,
    ).toBe("limit");
  });

  it("requires archiving for screen deletion and reports how many records hold values", async () => {
    const row = await field({ scope: "ROOM" });
    await expect(deleteCustomField(actor, row.id, true)).rejects.toMatchObject({
      fieldErrors: { id: expect.any(Array) },
    });
    await updateCustomField(actor, { id: row.id, archived: true });
    const room = await db.room.create({
      data: { name: randomUUID(), slug: randomUUID(), customValues: { [row.id]: "Saved" } },
    });
    roomIds.push(room.id);
    await expect(deleteCustomField(actor, row.id, true)).rejects.toMatchObject({
      fieldErrors: { id: [expect.stringContaining("1")] },
    });
    await db.room.update({ where: { id: room.id }, data: { customValues: {} } });
    await deleteCustomField(actor, row.id, true);
  });

  it("takes all linked fields along when a kind is archived and preserves the old links and values", async () => {
    const source = await kind(),
      target = await kind();
    const first = await field({ kindIds: [source.id] });
    const archived = await field({ kindIds: [source.id] });
    await updateCustomField(actor, { id: archived.id, archived: true });
    const device = await db.equipment.create({
      data: {
        name: randomUUID(),
        category: "OTHER",
        kindId: source.id,
        customValues: { [first.id]: "Saved" },
      },
    });
    equipmentIds.push(device.id);
    await updateDeviceKind(actor, source.id, { archived: true, moveDevicesTo: target.id });
    for (const row of [first, archived]) {
      expect(
        (await db.customFieldKind.findMany({ where: { fieldId: row.id } }))
          .map((link) => link.kindId)
          .sort(),
      ).toEqual([source.id, target.id].sort());
      expect(
        await db.activityLog.count({ where: { entityId: row.id, action: "CustomFieldUpdated" } }),
      ).toBe(1);
    }
    expect(await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).toMatchObject({
      kindId: target.id,
      customValues: { [first.id]: "Saved" },
    });
    await updateCustomField(actor, {
      id: first.id,
      name: randomUUID(),
      kindIds: [source.id, target.id],
    });
    await updateDeviceKind(actor, source.id, { archived: false });
    expect((await getRecordSchema("EQUIPMENT", source.id)).map((row) => row.id)).toContain(
      first.id,
    );
  });

  it("keeps accumulated archived-kind links editable after another kind move", async () => {
    const source = await kind(),
      target = await kind();
    const archived = await db.equipmentKind.createManyAndReturn({
      data: Array.from({ length: 79 }, () => ({
        name: randomUUID(),
        groupId: source.groupId,
        position: 0,
        archivedAt: new Date("2040-01-01T00:00:00Z"),
      })),
    });
    kindIds.push(...archived.map((row) => row.id));
    const ids = [...archived.map((row) => row.id), source.id];
    const row = await db.customField.create({
      data: {
        scope: "EQUIPMENT",
        type: "TEXT",
        key: `f_${randomUUID().replaceAll("-", "")}`,
        name: randomUUID(),
        kinds: { createMany: { data: ids.map((kindId) => ({ kindId })) } },
      },
    });
    fieldIds.push(row.id);
    await updateDeviceKind(actor, source.id, { archived: true, moveDevicesTo: target.id });
    const updated = await updateCustomField(actor, {
      id: row.id,
      name: randomUUID(),
      kindIds: [...ids, target.id],
    });
    expect(updated.kinds).toHaveLength(81);
  });

  it("refuses name overlap during a kind move, including archived fields, with no partial changes", async () => {
    const source = await kind(),
      target = await kind();
    const first = await field({ kindIds: [source.id] });
    const holder = await field({ name: first.name, kindIds: [target.id] });
    await updateCustomField(actor, { id: holder.id, archived: true });
    await expect(
      updateDeviceKind(actor, source.id, { archived: true, moveDevicesTo: target.id }),
    ).rejects.toMatchObject({
      fieldErrors: { moveDevicesTo: [expect.stringContaining(first.name)] },
    });
    expect(
      (await db.equipmentKind.findUniqueOrThrow({ where: { id: source.id } })).archivedAt,
    ).toBeNull();
    expect(
      await db.customFieldKind.count({ where: { fieldId: first.id, kindId: target.id } }),
    ).toBe(0);
  });

  it("refuses a kind move that would exceed 40 fields and names the fields", async () => {
    const source = await kind(),
      target = await kind();
    const moving = await field({ kindIds: [source.id] });
    const count = (await getRecordSchema("EQUIPMENT", target.id)).length;
    for (let n = count; n < 40; n++) await field({ kindIds: [target.id] });
    await expect(
      updateDeviceKind(actor, source.id, { archived: true, moveDevicesTo: target.id }),
    ).rejects.toMatchObject({
      fieldErrors: { moveDevicesTo: [expect.stringContaining(moving.name)] },
    });
    expect(
      await db.customFieldKind.count({ where: { fieldId: moving.id, kindId: target.id } }),
    ).toBe(0);
  });
});

describe("ambiguous numbers on forms only", () => {
  it.each(["de", "en"] as const)("refuses the thousands-like separator in %s", async (locale) => {
    const row = await field({ type: "NUMBER" });
    const form = new FormData();
    for (const raw of ["7", "12", "123"]) {
      form.set(`cf.${row.id}`, `${raw}${locale === "de" ? "." : ","}000`);
      expect(() =>
        runWithLocale(locale, () => valuesFromForm(form, [{ ...row, options: [] }])),
      ).toThrow();
    }
    for (const raw of [
      "0.123",
      "0,123",
      "1234.567",
      "1234,567",
      "12.34",
      "12,34",
      "-1.234",
      "+1,234",
    ]) {
      form.set(`cf.${row.id}`, raw);
      expect(
        runWithLocale(locale, () => valuesFromForm(form, [{ ...row, options: [] }]))[row.key],
      ).toBe(Number(raw.replace(",", ".")));
    }
  });
});
