import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { mcpActor, type McpContext } from "~/lib/mcp/types.server";
import { createVendor, updateVendor, deleteVendor } from "../vendors.mutations.server";
import { vendorCreateSchema, vendorEditSchema } from "../vendors.schema";

const run = `vendor-write-${crypto.randomUUID()}`;
let actor: ReturnType<typeof mcpActor>;
let locationId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { name: "Synthetic vendor member", email: `${run}@example.test` },
  });
  const context: McpContext = {
    user: { ...user, role: "MEMBER" },
    token: { id: "synthetic-token", name: "Vendor test", scope: "READ_WRITE" },
  };
  actor = mcpActor(context);
  const location = await db.location.create({ data: { name: run, kind: "STORAGE" } });
  locationId = location.id;
});

afterAll(async () => {
  await db.inventoryItem.deleteMany({ where: { name: { startsWith: run } } });
  await db.vendor.deleteMany({ where: { name: { startsWith: run } } });
  if (locationId) await db.location.delete({ where: { id: locationId } });
  if (actor) await db.user.delete({ where: { id: actor.id } });
});

describe("vendor schemas", () => {
  it("normalizes optional fields and validates name, email, URL and identifiers", () => {
    expect(
      vendorCreateSchema.parse({ name: " Supplier ", contact: "  ", locationId: " " }),
    ).toEqual({ name: "Supplier" });
    expect(
      vendorCreateSchema.parse({ name: "Supplier", email: " contact@example.test " }).email,
    ).toBe("contact@example.test");
    for (const input of [
      { name: " " },
      { name: "Supplier", email: "bad email" },
      { name: "Supplier", url: "javascript:alert(1)" },
      { name: "Supplier", url: "ftp://example.test/file" },
      { name: "Supplier", locationId: 12 },
    ]) {
      expect(vendorCreateSchema.safeParse(input).success).toBe(false);
    }
    expect(vendorEditSchema.safeParse({ id: " ", name: "Supplier" }).success).toBe(false);
  });
});

describe("vendor mutations", () => {
  it("rolls the vendor update back when the audit insert fails", async () => {
    const vendor = await createVendor(actor, vendorCreateSchema.parse({ name: `${run}-atomic` }));
    await expect(
      updateVendor(
        { ...actor, name: "Synthetic\u0000invalid audit snapshot" },
        vendor.id,
        vendorEditSchema.parse({ id: vendor.id, name: `${run}-rolled-back` }),
      ),
    ).rejects.toThrow();
    expect(await db.vendor.findUnique({ where: { id: vendor.id } })).toMatchObject({
      name: `${run}-atomic`,
    });
    expect(
      await db.activityLog.count({ where: { entityType: "vendor", entityId: vendor.id } }),
    ).toBe(1);
  });

  it("lets a member create, replace and delete a vendor with same-transaction audit rows", async () => {
    const vendor = await createVendor(
      actor,
      vendorCreateSchema.parse({
        name: ` ${run}-supplier `,
        contact: " Synthetic contact ",
        email: " supplier@example.test ",
        phone: " 12345 ",
        url: " https://example.test/supplier ",
        address: " Synthetic address ",
        locationId,
      }),
    );
    expect(await db.vendor.findUnique({ where: { id: vendor.id } })).toMatchObject({
      name: `${run}-supplier`,
      contact: "Synthetic contact",
      email: "supplier@example.test",
      phone: "12345",
      url: "https://example.test/supplier",
      address: "Synthetic address",
      locationId,
      createdById: actor.id,
    });
    const updated = await updateVendor(
      actor,
      vendor.id,
      vendorEditSchema.parse({
        id: vendor.id,
        name: `${run}-renamed`,
      }),
    );
    expect(updated).toMatchObject({
      name: `${run}-renamed`,
      contact: null,
      email: null,
      phone: null,
      url: null,
      address: null,
      locationId: null,
      createdById: actor.id,
    });
    const stock = await db.inventoryItem.create({
      data: { name: `${run}-stock`, vendorId: vendor.id },
    });
    expect(await deleteVendor(actor, vendor.id)).toMatchObject({
      id: vendor.id,
      name: `${run}-renamed`,
    });
    expect(await db.vendor.findUnique({ where: { id: vendor.id } })).toBeNull();
    expect(await db.inventoryItem.findUnique({ where: { id: stock.id } })).toMatchObject({
      id: stock.id,
      vendorId: null,
    });
    const history = await db.activityLog.findMany({
      where: { entityType: "vendor", entityId: vendor.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(history.map((entry) => entry.action)).toEqual([
      "VendorCreated",
      "VendorUpdated",
      "VendorDeleted",
    ]);
    for (const row of history) {
      expect(row.actorId).toBe(actor.id);
      expect(row.actorSnapshot).toMatchObject({
        via: "via MCP (Vendor test)",
        tokenId: "synthetic-token",
      });
    }
    expect(history[2].data).toMatchObject({ name: `${run}-renamed`, detachedStockItems: 1 });
  });

  it("rejects missing references without changing rows or adding audit history", async () => {
    await expect(
      createVendor(
        actor,
        vendorCreateSchema.parse({
          name: `${run}-invalid`,
          locationId: "missing-location",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.vendor.count({ where: { name: `${run}-invalid` } })).toBe(0);
    const vendor = await createVendor(
      actor,
      vendorCreateSchema.parse({ name: `${run}-unchanged` }),
    );
    await expect(
      updateVendor(
        actor,
        vendor.id,
        vendorEditSchema.parse({
          id: vendor.id,
          name: `${run}-wrong`,
          locationId: "missing-location",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.vendor.findUnique({ where: { id: vendor.id } })).toMatchObject({
      name: `${run}-unchanged`,
      locationId: null,
    });
    expect(
      await db.activityLog.count({ where: { entityType: "vendor", entityId: vendor.id } }),
    ).toBe(1);
    await expect(
      updateVendor(
        actor,
        "missing-vendor",
        vendorEditSchema.parse({
          id: "missing-vendor",
          name: run,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteVendor(actor, "missing-vendor")).rejects.toBeInstanceOf(NotFoundError);
  });
});
