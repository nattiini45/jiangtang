import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mcpError, registerTool, serializeMcp } from "~/lib/mcp/tools.server";
import { mcpActor, type McpContext } from "~/lib/mcp/types.server";
import { txWithAudit } from "~/lib/audit.server";
import { db } from "~/lib/db.server";
import { Prisma } from "~/generated/prisma/client";
import { BookingConflictError } from "~/lib/errors.server";

const context: McpContext = {
  user: {
    id: "test",
    name: "Synthetic member",
    email: "mcp@example.test",
    initials: null,
    role: "MEMBER",
  },
  token: { id: "token-test", name: "Test agent", scope: "READ_ONLY" },
};

async function callTool(
  principal: McpContext,
  options: { write?: boolean; role?: "ADMIN"; destructive?: boolean },
  args: Record<string, unknown> = {},
) {
  const server = new McpServer({ name: "test", version: "1" });
  let called = false;
  registerTool(
    server,
    principal,
    {
      name: "test_tool",
      description: "Test permission boundary",
      schema: z.object({ confirm: z.boolean().optional() }),
      ...options,
    },
    async () => {
      called = true;
      return { ok: true };
    },
  );
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    return { result: await client.callTool({ name: "test_tool", arguments: args }), called };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP tool boundary", () => {
  it("sanitizes raw exclusion details but keeps intended booking conflict labels", async () => {
    const raw = await mcpError(
      Object.assign(new Error("Private exclusion database details"), { code: "23P01" }),
    );
    expect(JSON.stringify(raw.content)).toContain("409");
    expect(JSON.stringify(raw.content)).not.toContain("Private exclusion database details");
    const conflict = await mcpError(
      new BookingConflictError("Synthetic competing booking synthetic-id"),
    );
    expect(JSON.stringify(conflict.content)).toContain("Synthetic competing booking synthetic-id");
  });
  it("transforms raw SDK input exactly once", async () => {
    let transforms = 0;
    const server = new McpServer({ name: "test", version: "1" });
    registerTool(
      server,
      context,
      {
        name: "transform_input",
        description: "Parse a CSV field and an ISO instant",
        schema: z.object({
          flag: z.preprocess((value) => value ?? false, z.boolean()),
          csv: z.string().transform((value) => {
            transforms++;
            return value.split(",");
          }),
          at: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
        }),
      },
      async (input) => ({ fields: input.csv, at: input.at, flag: input.flag }),
    );
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({
        name: "transform_input",
        arguments: { csv: "a,b", at: "2026-07-01T12:00:00+02:00" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        result: { fields: ["a", "b"], at: { iso: "2026-07-01T10:00:00.000Z" }, flag: false },
      });
      expect(transforms).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("never returns unexpected exception details even outside production", async () => {
    const result = await mcpError(new Error("Private application internals"));
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Expected text error");
    expect(JSON.parse(content.text).status).toBe(500);
    expect(content.text).not.toContain("Private application internals");
  });
  it.each([
    ["P2025", 404],
    ["P2002", 409],
    ["P2003", 422],
  ] as const)("maps %s without exposing raw database details", async (code, status) => {
    const result = await mcpError(
      new Prisma.PrismaClientKnownRequestError("Private SQL details", { code, clientVersion: "7" }),
    );
    expect(result.isError).toBe(true);
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Expected text error");
    expect(JSON.parse(content.text).status).toBe(status);
    expect(content.text).not.toContain("Private SQL details");
  });
  it("refuses write calls with a read-only token before reaching the domain", async () => {
    const { result, called } = await callTool(context, { write: true });
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"status":403') }),
    ]);
  });

  it("keeps member tokens out of admin operations regardless of scope", async () => {
    const { result, called } = await callTool(
      { ...context, token: { ...context.token, scope: "READ_WRITE" } },
      { role: "ADMIN" },
    );
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("requires explicit confirmation for destructive writes", async () => {
    const writable: McpContext = { ...context, token: { ...context.token, scope: "READ_WRITE" } };
    const refused = await callTool(writable, { write: true, destructive: true });
    expect(refused.called).toBe(false);
    expect(refused.result.isError).toBe(true);
    const accepted = await callTool(
      writable,
      { write: true, destructive: true },
      { confirm: true },
    );
    expect(accepted.called).toBe(true);
    expect(accepted.result.isError).not.toBe(true);
  });

  it("returns ISO instants and Berlin display values without host timezone dependence", () => {
    const result = serializeMcp({ at: new Date("2026-07-01T10:00:00.000Z") }) as {
      at: { iso: string; berlin: string };
    };
    expect(result.at.iso).toBe("2026-07-01T10:00:00.000Z");
    expect(result.at.berlin).toContain("12:00");
    expect(serializeMcp({ price: new Prisma.Decimal("123.45") })).toEqual({ price: "123.45" });
  });

  it("records the user and MCP token name in the immutable actor snapshot", async () => {
    const user = await db.user.create({
      data: {
        email: `mcp-audit-${crypto.randomUUID()}@example.test`,
        name: "Synthetic MCP audit user",
      },
    });
    const entityId = crypto.randomUUID();
    try {
      const principal: McpContext = { ...context, user: { ...context.user, id: user.id } };
      await txWithAudit(mcpActor(principal), async (_tx, audit) => {
        await audit({ action: "McpBoundaryTest", entityType: "task", entityId });
      });
      const row = await db.activityLog.findFirstOrThrow({
        where: { entityId, action: "McpBoundaryTest" },
      });
      expect(row.actorId).toBe(user.id);
      expect(row.actorSnapshot).toMatchObject({
        name: context.user.name,
        via: "via MCP (Test agent)",
        tokenId: "token-test",
      });
    } finally {
      await db.user.delete({ where: { id: user.id } });
    }
  });
});
