import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { FieldNameConflictError, toErrorResponse } from "~/lib/errors.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { createCustomField, updateCustomField } from "../definitions.server";

const actor = { name: "Synthetic field administrator" };
const ids: string[] = [];
afterEach(async () => {
  await db.customField.deleteMany({ where: { id: { in: ids.splice(0) } } });
});
async function field(
  name: string,
  kindIds: string[] = [],
  scope: "ROOM" | "EQUIPMENT" = "EQUIPMENT",
) {
  const created = await createCustomField(actor, {
    scope,
    key: `f_${randomUUID().replaceAll("-", "")}`,
    name,
    kindIds,
    type: "TEXT",
  });
  ids.push(created.id);
  return created;
}

describe("scope-unique field names", () => {
  it("refuses case-insensitive duplicates across disjoint kinds on create and rename", async () => {
    const [a, b] = await db.equipmentKind.findMany({ where: { archivedAt: null }, take: 2 });
    const holder = await field(randomUUID(), [a.id]);
    await expect(field(holder.name.toUpperCase(), [b.id])).rejects.toMatchObject({
      holderId: holder.id,
    });
    const other = await field(randomUUID(), [b.id]);
    await expect(
      updateCustomField(actor, { id: other.id, name: holder.name }),
    ).rejects.toMatchObject({ holderId: holder.id });
    await updateCustomField(actor, { id: holder.id, name: holder.name.toUpperCase() });
    expect((await db.customField.findUniqueOrThrow({ where: { id: other.id } })).name).toBe(
      other.name,
    );
  });

  it("identifies archived holders and their kinds in the response", async () => {
    const kind = await db.equipmentKind.findFirstOrThrow({ where: { archivedAt: null } });
    const holder = await field(randomUUID(), [kind.id]);
    await updateCustomField(actor, { id: holder.id, archived: true });
    const error = await runWithLocale("en", () => field(holder.name).catch((error) => error));
    expect(error).toBeInstanceOf(FieldNameConflictError);
    expect(error.fieldErrors.name[0]).toContain("archived");
    expect(error.fieldErrors.name[0]).toContain(kind.name);
    expect(await toErrorResponse(error).json()).toMatchObject({ holderId: holder.id });
  });

  it("keeps room names unique and scopes separate", async () => {
    const room = await field(randomUUID(), [], "ROOM");
    await field(room.name);
    await expect(field(room.name.toUpperCase(), [], "ROOM")).rejects.toMatchObject({
      holderId: room.id,
    });
    const other = await field(randomUUID(), [], "ROOM");
    await expect(updateCustomField(actor, { id: other.id, name: room.name })).rejects.toMatchObject(
      { holderId: room.id },
    );
  });

  it("serializes two writers before they reach the unique index", async () => {
    const name = randomUUID();
    const attempts = await Promise.allSettled([field(name), field(name.toUpperCase())]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      FieldNameConflictError,
    );
  });
});
