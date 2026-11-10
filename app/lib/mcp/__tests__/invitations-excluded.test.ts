import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "~/lib/mcp/server.server";

describe("invitations stay outside MCP", () => {
  it("exposes no invitation tools even to an admin with write access", async () => {
    const server = createMcpServer({
      user: {
        id: "synthetic",
        name: "Admin",
        email: "admin@example.test",
        initials: null,
        role: "ADMIN",
      },
      token: { id: "synthetic", name: "Test", scope: "READ_WRITE" },
    });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(
        tools.map((tool) => tool.name).filter((name) => /invit|user_management/i.test(name)),
      ).toEqual([]);
      for (const name of [
        "list_invitations",
        "create_invitation",
        "revoke_invitation",
        "reissue_invitation",
      ]) {
        await expect(client.callTool({ name, arguments: {} })).rejects.toThrow();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
