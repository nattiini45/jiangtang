import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerPlaceWrites } from "~/lib/mcp/place-writes.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { ValidationError } from "~/lib/errors.server";

const mutations = vi.hoisted(() =>
  Object.fromEntries(
    [
      "createCampus",
      "updateCampus",
      "createBuilding",
      "updateBuilding",
      "createRoom",
      "updateRoom",
      "retireRoom",
      "cloneRoom",
      "bulkCreateRooms",
      "createLocation",
      "updateLocation",
      "moveLocation",
      "deleteLocation",
      "createModel",
      "updateModel",
      "createEquipment",
      "updateEquipment",
      "retireEquipment",
      "setSubstitution",
      "bulkCreateEquipment",
      "createStockItem",
      "updateStockItem",
      "deleteStockItem",
      "linkStockItemToEquipment",
      "unlinkStockItemFromEquipment",
      "createVendor",
      "updateVendor",
      "deleteVendor",
    ].map((name) => [name, vi.fn()]),
  ),
);
vi.mock("~/domains/rooms/rooms.mutations.server", () => mutations);
vi.mock("~/domains/locations/locations.mutations.server", () => mutations);
vi.mock("~/domains/catalog/catalog.mutations.server", () => mutations);
vi.mock("~/domains/inventory/inventory.mutations.server", () => mutations);
vi.mock("~/domains/inventory/inventory.stock.mutations.server", () => mutations);
vi.mock("~/domains/vendors/vendors.mutations.server", () => mutations);
vi.mock("~/lib/realtime/emit.server", () => ({ emitChange: vi.fn() }));
import { emitChange } from "~/lib/realtime/emit.server";

const member: McpContext = {
  user: {
    id: "member",
    name: "Synthetic member",
    email: "member@example.test",
    initials: null,
    role: "MEMBER",
  },
  token: { id: "token", name: "Writer test", scope: "READ_WRITE" },
};
const admin: McpContext = { ...member, user: { ...member.user, role: "ADMIN" } };
const room = { name: "Synthetic room" };
const equipment = { category: "OTHER", mobility: "POOLED" };
const stock = { name: "Synthetic stock" };
const cases = [
  ["create_campus", "createCampus", { name: "Campus" }, "campus", "created"],
  ["update_campus", "updateCampus", { id: "campus", name: "Campus" }, "campus", "updated"],
  [
    "create_building",
    "createBuilding",
    { name: "Building", campusId: "campus" },
    "building",
    "created",
  ],
  [
    "update_building",
    "updateBuilding",
    { id: "building", name: "Building", campusId: "campus" },
    "building",
    "updated",
  ],
  ["create_room", "createRoom", room, "room", "created"],
  ["update_room", "updateRoom", { id: "room", input: room }, "room", "updated"],
  ["retire_room", "retireRoom", { id: "room", confirm: true }, "room", "updated"],
  ["clone_room", "cloneRoom", { sourceSlug: "source-slug", input: room }, "room", "created"],
  ["bulk_create_rooms", "bulkCreateRooms", { rows: [room] }, "room", "created"],
  [
    "create_location",
    "createLocation",
    { name: "Location", kind: "STORAGE" },
    "location",
    "created",
  ],
  [
    "update_location",
    "updateLocation",
    { id: "location", name: "Location", kind: "STORAGE" },
    "location",
    "updated",
  ],
  ["move_location", "moveLocation", { id: "location", parentId: null }, "location", "updated"],
  ["delete_location", "deleteLocation", { id: "location", confirm: true }, "location", "deleted"],
  [
    "create_equipment_model",
    "createModel",
    { name: "Model", category: "OTHER" },
    "equipmentModel",
    "created",
  ],
  [
    "update_equipment_model",
    "updateModel",
    { id: "model", input: { name: "Model", category: "OTHER" } },
    "equipmentModel",
    "updated",
  ],
  ["create_equipment", "createEquipment", equipment, "equipment", "created"],
  [
    "update_equipment",
    "updateEquipment",
    { id: "equipment", input: equipment },
    "equipment",
    "updated",
  ],
  [
    "retire_equipment",
    "retireEquipment",
    { id: "equipment", confirm: true },
    "equipment",
    "updated",
  ],
  [
    "set_equipment_substitution",
    "setSubstitution",
    { spareId: "equipment", faultyId: "faulty", confirm: true },
    "equipment",
    "updated",
  ],
  [
    "bulk_create_equipment",
    "bulkCreateEquipment",
    { rows: [{ kategorie: "OTHER", mobilitaet: "POOLED" }] },
    "equipment",
    "created",
  ],
  ["create_stock_item", "createStockItem", stock, "inventory-item", "created"],
  ["update_stock_item", "updateStockItem", { id: "stock", ...stock }, "inventory-item", "updated"],
  [
    "delete_stock_item",
    "deleteStockItem",
    { id: "stock", confirm: true },
    "inventory-item",
    "deleted",
  ],
  [
    "link_stock_item_to_equipment",
    "linkStockItemToEquipment",
    { id: "stock", equipmentId: "equipment" },
    "inventory-item",
    "updated",
  ],
  [
    "unlink_stock_item_from_equipment",
    "unlinkStockItemFromEquipment",
    { id: "stock", confirm: true },
    "inventory-item",
    "updated",
  ],
  ["create_vendor", "createVendor", { name: "Vendor" }, "vendor", "created"],
  ["update_vendor", "updateVendor", { id: "vendor", name: "Vendor" }, "vendor", "updated"],
  ["delete_vendor", "deleteVendor", { id: "vendor", confirm: true }, "vendor", "deleted"],
] as const;

type Registered = {
  config: { annotations: Record<string, unknown> };
  handler: (input: unknown) => Promise<CallToolResult>;
};
let registry: Map<string, Registered>;
function register(context: McpContext = member) {
  registry = new Map();
  const server = {
    registerTool: (name: string, config: Registered["config"], handler: Registered["handler"]) => {
      registry.set(name, { config, handler });
    },
  };
  registerPlaceWrites(server as unknown as McpServer, context);
}
function call(name: string, input: unknown) {
  return registry.get(name)!.handler(input);
}
function status(result: CallToolResult) {
  return JSON.parse((result.content[0] as { text: string }).text).status;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, mutation] of Object.entries(mutations)) {
    mutation.mockReset();
    mutation.mockResolvedValue(
      name.startsWith("bulk") ? { created: 1 } : { id: "result-id", name: "Synthetic result" },
    );
  }
  register();
});

describe("MCP place write registry", () => {
  it("exposes exactly the supported mutations and no catalog delete or user management", () => {
    expect([...registry.keys()].sort()).toEqual(cases.map(([name]) => name).sort());
    for (const tool of registry.values()) expect(tool.config.annotations.readOnlyHint).toBe(false);
  });

  it.each(cases)(
    "%s uses its domain mutation, keeps actor metadata and emits after success",
    async (name, mutation, args, entityType, op) => {
      const principal = name.startsWith("bulk_") ? admin : member;
      register(principal);
      const result = await call(name, args);
      expect(result.isError).not.toBe(true);
      expect(mutations[mutation]).toHaveBeenCalledTimes(1);
      expect(mutations[mutation].mock.calls[0][0]).toEqual({
        ...principal.user,
        via: { kind: "mcp", tokenId: "token", tokenName: "Writer test" },
      });
      expect(emitChange).toHaveBeenCalledWith({
        entityType,
        id: name.startsWith("bulk_") ? "bulk" : "result-id",
        op,
      });
      expect(mutations[mutation].mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(emitChange).mock.invocationCallOrder[0],
      );
      expect(result.structuredContent).toMatchObject({
        result: name.startsWith("bulk_")
          ? { created: 1 }
          : { id: "result-id", name: "Synthetic result" },
      });
    },
  );

  it.each(cases)(
    "%s refuses read-only tokens before any domain write",
    async (name, mutation, args) => {
      register({ ...admin, token: { ...admin.token, scope: "READ_ONLY" } });
      expect(status(await call(name, args))).toBe(403);
      expect(mutations[mutation]).not.toHaveBeenCalled();
      expect(emitChange).not.toHaveBeenCalled();
    },
  );

  it.each(cases.filter(([name]) => name.startsWith("bulk_")))(
    "%s preserves the UI's ADMIN-only import permission",
    async (name, mutation, args) => {
      expect(status(await call(name, args))).toBe(403);
      expect(mutations[mutation]).not.toHaveBeenCalled();
    },
  );

  it.each(cases.filter(([, , args]) => "confirm" in args))(
    "%s requires explicit true confirmation and advertises destruction",
    async (name, mutation, args) => {
      expect(registry.get(name)!.config.annotations.destructiveHint).toBe(true);
      for (const confirm of [undefined, false, "true"]) {
        expect(status(await call(name, { ...args, confirm }))).toBe(422);
      }
      expect(mutations[mutation]).not.toHaveBeenCalled();
      expect(emitChange).not.toHaveBeenCalled();
    },
  );

  it("retains domain validation and does not notify on a failed mutation", async () => {
    mutations.moveLocation.mockRejectedValueOnce(
      new ValidationError({ parentId: ["Invalid parent"] }),
    );
    const result = await call("move_location", { id: "location", parentId: "descendant" });
    expect(status(result)).toBe(422);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("parentId") }),
    ]);
    expect(emitChange).not.toHaveBeenCalled();
  });

  it("waits for the domain promise to commit before notifying", async () => {
    let commit!: (value: { id: string }) => void;
    mutations.createVendor.mockReturnValueOnce(
      new Promise((resolve) => {
        commit = resolve;
      }),
    );
    const pending = call("create_vendor", { name: "Vendor" });
    expect(emitChange).not.toHaveBeenCalled();
    commit({ id: "committed" });
    await pending;
    expect(emitChange).toHaveBeenCalledWith({
      entityType: "vendor",
      id: "committed",
      op: "created",
    });
  });

  it("passes IDs, normalized inputs and substitution clears without dropping their meaning", async () => {
    await call("clone_room", {
      sourceSlug: "source-slug",
      input: { name: " Clone ", copyEquipment: true },
    });
    expect(mutations.cloneRoom).toHaveBeenCalledWith(
      expect.anything(),
      "source-slug",
      expect.objectContaining({ name: "Clone", copyEquipment: true }),
    );
    await call("set_equipment_substitution", { spareId: "spare", faultyId: null, confirm: true });
    expect(mutations.setSubstitution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spareId: "spare", faultyId: null }),
    );
    await call("link_stock_item_to_equipment", { id: "stock", equipmentId: "equipment" });
    expect(mutations.linkStockItemToEquipment).toHaveBeenCalledWith(
      expect.anything(),
      "stock",
      "equipment",
    );
    await call("update_vendor", { id: "vendor", name: " Vendor ", contact: " " });
    expect(mutations.updateVendor).toHaveBeenCalledWith(expect.anything(), "vendor", {
      id: "vendor",
      name: "Vendor",
    });
  });

  it.each([
    ["create_room", { ...room, renewalFrom: "2026-11-09T12:00" }],
    ["update_room", { id: "room", input: { ...room, renewalTo: "2026-11-09" } }],
    ["create_equipment", { ...equipment, lastLampChangeAt: "2026-11-09T12:00" }],
    [
      "update_equipment",
      { id: "equipment", input: { ...equipment, lastLampChangeAt: "2026-11-09" } },
    ],
    ["create_stock_item", { ...stock, purchasedAt: "2026-11-09" }],
    ["update_stock_item", { id: "stock", ...stock, warrantyExpiresAt: "2026-11-09T12:00" }],
    ["create_vendor", { name: "Vendor", email: "bad email" }],
    ["create_equipment", { category: "OTHER", mobility: "FIXED" }],
    [
      "create_room",
      { ...room, renewalFrom: "2026-11-10T12:00:00Z", renewalTo: "2026-11-09T12:00:00Z" },
    ],
  ])("%s validates before its domain write", async (name, input) => {
    expect(status(await call(name, input))).toBe(422);
    for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
    expect(emitChange).not.toHaveBeenCalled();
  });

  it("normalizes offset instants through the existing form schemas", async () => {
    await call("create_room", { ...room, renewalFrom: "2026-11-09T12:00:00+01:00" });
    expect(mutations.createRoom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ renewalFrom: new Date("2026-11-09T11:00:00Z") }),
    );
    await call("create_stock_item", {
      ...stock,
      purchasedAt: null,
      warrantyExpiresAt: "2026-11-09T12:00:00Z",
    });
    expect(mutations.createStockItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purchasedAt: null,
        warrantyExpiresAt: new Date("2026-11-09T12:00:00Z"),
      }),
    );
  });

  it("does not pass equipment-link edits through the stock update tool", async () => {
    expect(
      (await call("update_stock_item", { id: "stock", name: "Stock", equipmentId: "other" }))
        .isError,
    ).not.toBe(true);
    expect(mutations.updateStockItem).toHaveBeenCalledWith(
      expect.anything(),
      "stock",
      expect.not.objectContaining({ equipmentId: expect.anything() }),
    );
  });

  it("points retirement attempts at the confirmed tool before any equipment write", async () => {
    const result = await call("update_equipment", {
      id: "equipment",
      input: { ...equipment, status: "RETIRED" },
    });
    expect(status(result)).toBe(422);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("retire_equipment") }),
    ]);
    expect(mutations.updateEquipment).not.toHaveBeenCalled();
    expect(emitChange).not.toHaveBeenCalled();
  });

  it.each([
    ["bulk_create_rooms", "bulkCreateRooms", { rows: [room] }],
    [
      "bulk_create_equipment",
      "bulkCreateEquipment",
      { rows: [{ kategorie: "OTHER", mobilitaet: "POOLED" }] },
    ],
  ])(
    "%s returns created IDs and labels without losing its count",
    async (name, mutation, input) => {
      register(admin);
      const result = { created: 1, items: [{ id: "committed-id", name: "Committed label" }] };
      mutations[mutation].mockResolvedValueOnce(result);
      expect((await call(name, input)).structuredContent).toMatchObject({ result });
    },
  );

  it("registers, lists and calls every write through the stable v2 SDK", async () => {
    const server = new McpServer({ name: "place-writes-test", version: "1" });
    registerPlaceWrites(server, admin);
    const client = new Client({ name: "place-writes-client", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
        cases.map(([name]) => name).sort(),
      );
      for (const [name, , args] of cases) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, JSON.stringify({ name, result })).not.toBe(true);
      }
      const dated = await client.callTool({
        name: "create_room",
        arguments: { ...room, renewalFrom: "2026-11-09T12:00:00+01:00" },
      });
      expect(dated.isError).not.toBe(true);
      expect(mutations.createRoom).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ renewalFrom: new Date("2026-11-09T11:00:00Z") }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
