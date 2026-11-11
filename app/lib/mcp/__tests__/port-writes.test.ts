import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerPortWrites } from "~/lib/mcp/port-writes.server";
import type { McpContext } from "~/lib/mcp/types.server";

const mutations = vi.hoisted(() => ({
  setEquipmentModelPorts: vi.fn(),
  mutateEquipmentPort: vi.fn(),
}));
vi.mock("~/domains/catalog/catalog.ports.mutations.server", () => mutations);
vi.mock("~/domains/inventory/inventory.ports.mutations.server", () => mutations);
const context: McpContext = {
  user: {
    id: "member",
    name: "Synthetic member",
    email: "ports@example.test",
    initials: null,
    role: "MEMBER",
  },
  token: { id: "token", name: "Synthetic writer", scope: "READ_WRITE" },
};
const input = {
  label: "HDMI",
  connector: "HDMI",
  direction: "INPUT",
  signal: "VIDEO",
  position: 0,
};
async function call(
  name: string,
  args: Record<string, unknown>,
  scope: McpContext["token"]["scope"] = "READ_WRITE",
) {
  const server = new McpServer({ name: "ports-test", version: "1" });
  registerPortWrites(server, { ...context, token: { ...context.token, scope } });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  mutations.setEquipmentModelPorts.mockResolvedValue([]);
  mutations.mutateEquipmentPort.mockResolvedValue({ id: "port" });
});
describe("port write tools", () => {
  for (const [name, args] of [
    ["set_equipment_model_ports", { modelId: "model", ports: [input] }],
    ["add_equipment_port", { equipmentId: "unit", input }],
    ["update_equipment_port", { equipmentId: "unit", portId: "port", input }],
    ["remove_equipment_port", { equipmentId: "unit", portId: "port", confirm: true }],
    ["inherit_equipment_model_ports", { equipmentId: "unit" }],
  ] as const) {
    it(`${name} accepts a member writer and rejects read-only`, async () => {
      expect((await call(name, args)).isError).not.toBe(true);
      const calls =
        mutations.mutateEquipmentPort.mock.calls.length +
        mutations.setEquipmentModelPorts.mock.calls.length;
      expect(calls).toBe(1);
      expect((await call(name, args, "READ_ONLY")).isError).toBe(true);
      expect(
        mutations.mutateEquipmentPort.mock.calls.length +
          mutations.setEquipmentModelPorts.mock.calls.length,
      ).toBe(calls);
    });
  }
  it("requires removal confirmation and rejects unknown connectors", async () => {
    expect(
      (await call("remove_equipment_port", { equipmentId: "unit", portId: "port" })).isError,
    ).toBe(true);
    expect(
      (
        await call("add_equipment_port", {
          equipmentId: "unit",
          input: { ...input, connector: "INVALID" },
        })
      ).isError,
    ).toBe(true);
    expect(mutations.mutateEquipmentPort).not.toHaveBeenCalled();
  });
});
