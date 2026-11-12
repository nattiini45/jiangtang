import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import {
  createCustomField,
  updateCustomField,
  updateFieldOptions,
  deleteCustomField,
  getRecordSchema,
} from "../definitions.server";

const actor = { name: "Synthetic field administrator" };
const ids: string[] = [];
afterEach(async () => {
  await db.customField.deleteMany({ where: { id: { in: ids.splice(0) } } });
});
const field = async (extra = {}) => {
  const created = await createCustomField(actor, {
    scope: "EQUIPMENT",
    key: `f_${randomUUID().replaceAll("-", "")}`,
    name: randomUUID(),
    type: "TEXT",
    ...extra,
  });
  ids.push(created.id);
  return created;
};

describe("custom field definitions", () => {
  it("defines once per scope and links several kinds, or every kind", async () => {
    const kinds = await db.equipmentKind.findMany({ take: 2 });
    const created = await field({
      kindIds: kinds.map((kind) => kind.id),
      position: 17,
      showInList: true,
      searchable: false,
    });
    expect(created.kinds).toHaveLength(2);
    expect((await getRecordSchema("EQUIPMENT", kinds[0].id)).map((row) => row.id)).toContain(
      created.id,
    );
    expect((await getRecordSchema("EQUIPMENT")).map((row) => row.id)).not.toContain(created.id);
    await expect(field({ key: created.key })).rejects.toThrow();
    await expect(field({ name: created.name.toUpperCase() })).rejects.toThrow();
    await expect(field({ scope: "ROOM", kindIds: [kinds[0].id] })).rejects.toThrow();
    const archived = await updateCustomField(actor, { id: created.id, archived: true });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived).toMatchObject({
      kinds: created.kinds,
      position: 17,
      showInList: true,
      searchable: false,
    });
    expect((await getRecordSchema("EQUIPMENT", kinds[0].id)).map((row) => row.id)).not.toContain(
      created.id,
    );
    await updateCustomField(actor, {
      id: created.id,
      archived: false,
      name: "Renamed " + randomUUID(),
      kindIds: [],
    });
    expect((await getRecordSchema("EQUIPMENT")).map((row) => row.id)).toContain(created.id);
    await deleteCustomField(actor, created.id);
    const audit = await db.activityLog.findMany({
      where: { entityType: "customField", entityId: created.id },
    });
    expect(audit.map((row) => row.action).sort()).toEqual(
      [
        "CustomFieldCreated",
        "CustomFieldArchived",
        "CustomFieldRestored",
        "CustomFieldDeleted",
      ].sort(),
    );
  });

  it("adds, renames, reorders, retires, restores and deletes options atomically", async () => {
    const created = await field({ type: "CHOICE" });
    let result = await updateFieldOptions(actor, {
      fieldId: created.id,
      changes: [
        { op: "add", label: "First" },
        { op: "add", label: "Second" },
      ],
    });
    const first = result.options.find((option) => option.label === "First")!;
    await expect(
      updateFieldOptions(actor, {
        fieldId: created.id,
        changes: [
          { op: "add", label: "Third" },
          { op: "add", label: "FIRST" },
        ],
      }),
    ).rejects.toThrow();
    expect(await db.customFieldOption.count({ where: { fieldId: created.id } })).toBe(2);
    result = await updateFieldOptions(actor, {
      fieldId: created.id,
      changes: [{ op: "update", id: first.id, label: "Renamed", position: 20, archived: true }],
    });
    expect(result.options.find((option) => option.id === first.id)).toMatchObject({
      label: "Renamed",
      position: 20,
      archivedAt: expect.any(Date),
    });
    await updateFieldOptions(actor, {
      fieldId: created.id,
      changes: [
        { op: "update", id: first.id, archived: false },
        { op: "delete", id: first.id },
      ],
    });
    expect(await db.customFieldOption.count({ where: { fieldId: created.id } })).toBe(1);
    await deleteCustomField(actor, created.id);
  });

  it("serializes concurrent definitions and counts overlaps across kinds", async () => {
    const group = await db.equipmentFunctionGroup.findFirstOrThrow();
    const kind = await db.equipmentKind.create({
      data: { name: randomUUID(), groupId: group.id, position: 90 },
    });
    const existing = (await getRecordSchema("EQUIPMENT", kind.id)).length;
    const created: string[] = [];
    for (let n = existing; n < 39; n++) created.push((await field({ kindIds: [kind.id] })).id);
    const attempts = await Promise.allSettled([
      field({ kindIds: [kind.id] }),
      field({ kindIds: [kind.id] }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const attempt of attempts)
      if (attempt.status === "fulfilled") created.push(attempt.value.id);
    await expect(field({ kindIds: [kind.id] })).rejects.toMatchObject({
      fieldErrors: { kindIds: [expect.stringContaining("40")] },
    });
    await updateCustomField(actor, { id: created[0], archived: true });
    const replacement = await field({ kindIds: [kind.id] });
    await expect(
      updateCustomField(actor, { id: created[0], archived: false }),
    ).rejects.toMatchObject({ fieldErrors: { kindIds: [expect.stringContaining("40")] } });
    for (const id of [...created, replacement.id]) await deleteCustomField(actor, id);
    await db.equipmentKind.delete({ where: { id: kind.id } });
  });

  it("enforces 50 active options with retire as the way out", async () => {
    const created = await field({ type: "MULTI_CHOICE" });
    const result = await updateFieldOptions(actor, {
      fieldId: created.id,
      changes: Array.from({ length: 50 }, (_, n) => ({ op: "add" as const, label: `Option ${n}` })),
    });
    await expect(
      updateFieldOptions(actor, {
        fieldId: created.id,
        changes: [{ op: "add", label: "Over limit" }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { changes: [expect.stringContaining("50")] } });
    await updateFieldOptions(actor, {
      fieldId: created.id,
      changes: [
        { op: "update", id: result.options[0].id, archived: true },
        { op: "add", label: "Replacement" },
      ],
    });
    await expect(
      updateFieldOptions(actor, {
        fieldId: created.id,
        changes: [{ op: "update", id: result.options[0].id, archived: false }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { changes: [expect.stringContaining("50")] } });
    await deleteCustomField(actor, created.id);
  });
});
