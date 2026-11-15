import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { FieldNameConflictError, toErrorResponse } from "~/lib/errors.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { mcpError } from "~/lib/mcp/tools.server";
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
async function kinds() {
  return db.equipmentKind.findMany({ where: { archivedAt: null }, take: 3 });
}

describe("field names across device kinds", () => {
  it("allows disjoint kinds, including archived definitions, but keeps keys unique", async () => {
    const [a, b] = await kinds();
    const name = randomUUID();
    const first = await field(name, [a.id]);
    await updateCustomField(actor, { id: first.id, archived: true });
    const second = await field(name.toUpperCase(), [b.id]);
    await updateCustomField(actor, { id: first.id, archived: false });
    expect(second.name).toBe(name.toUpperCase());
    await expect(
      createCustomField(actor, {
        scope: "EQUIPMENT",
        key: first.key,
        name: randomUUID(),
        type: "TEXT",
        kindIds: [b.id],
      }),
    ).rejects.toThrow();
  });

  it("refuses overlap on create, rename and widening with the holder and its coverage", async () => {
    const [a, b, c] = await kinds();
    const name = randomUUID();
    const holder = await field(name, [a.id, b.id]);
    const other = await field(randomUUID(), [c.id]);
    await expect(field(name.toUpperCase(), [b.id, c.id])).rejects.toMatchObject({
      holderId: holder.id,
    });
    await updateCustomField(actor, { id: other.id, kindIds: [b.id] });
    await expect(updateCustomField(actor, { id: other.id, name })).rejects.toMatchObject({
      holderId: holder.id,
    });
    await updateCustomField(actor, { id: other.id, kindIds: [c.id], name });
    await expect(
      updateCustomField(actor, { id: other.id, kindIds: [a.id, c.id] }),
    ).rejects.toMatchObject({ holderId: holder.id });
    expect(
      (await db.customFieldKind.findMany({ where: { fieldId: other.id } })).map(
        (row) => row.kindId,
      ),
    ).toEqual([c.id]);
    await updateCustomField(actor, { id: holder.id, archived: true });
    const error = await runWithLocale("en", () => field(name, [a.id]).catch((error) => error));
    expect(error).toBeInstanceOf(FieldNameConflictError);
    expect(error.fieldErrors.name[0]).toContain("archived");
    expect(error.fieldErrors.name[0]).toContain(a.name);
    expect(error.fieldErrors.name[0]).toContain(b.name);
    expect(await toErrorResponse(error).json()).toMatchObject({ holderId: holder.id });
    const mcp = await mcpError(error);
    expect(JSON.stringify(mcp.content)).toContain(holder.id);
    expect(JSON.stringify(mcp.content)).toContain("archived");
  });

  it("refuses global against restricted in either direction and when widening to global", async () => {
    const [kind] = await kinds();
    const global = await field(randomUUID());
    await expect(field(global.name, [kind.id])).rejects.toMatchObject({ holderId: global.id });
    const restricted = await field(randomUUID(), [kind.id]);
    await expect(field(restricted.name)).rejects.toMatchObject({ holderId: restricted.id });
    const [a, b] = await kinds();
    const first = await field(randomUUID(), [a.id]);
    const second = await field(first.name, [b.id]);
    await expect(updateCustomField(actor, { id: second.id, kindIds: [] })).rejects.toMatchObject({
      holderId: first.id,
    });
  });

  it("keeps room names unique including archived names, separately from devices", async () => {
    const name = randomUUID();
    const room = await field(name, [], "ROOM");
    await field(name);
    await expect(field(name.toUpperCase(), [], "ROOM")).rejects.toMatchObject({
      holderId: room.id,
    });
    await updateCustomField(actor, { id: room.id, archived: true });
    await expect(field(name, [], "ROOM")).rejects.toMatchObject({ holderId: room.id });
  });

  it("serializes competing creates and competing scope changes", async () => {
    const [a, b, c] = await kinds();
    const name = randomUUID();
    const attempts = await Promise.allSettled([
      field(name, [a.id]),
      field(name.toUpperCase(), [a.id]),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const first = await field(randomUUID(), [a.id]);
    const second = await field(first.name, [b.id]);
    const changes = await Promise.allSettled([
      updateCustomField(actor, { id: first.id, kindIds: [a.id, c.id] }),
      updateCustomField(actor, { id: second.id, kindIds: [b.id, c.id] }),
    ]);
    expect(changes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
});
