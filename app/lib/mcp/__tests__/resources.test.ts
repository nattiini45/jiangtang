import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpServer } from "~/lib/mcp/server.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { db } from "~/lib/db.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";
import { logger } from "~/lib/observability/logger.server";

const prefix = `mcp-resources-${crypto.randomUUID()}`;
const roomId = `${prefix}-room-00`;
const equipmentId = `${prefix}-equipment`;
const eventId = `${prefix}-event`;
const ticketId = `${prefix}-ticket`;
const projectId = `${prefix}-project`;
const taskId = `${prefix}-task`;
const noteId = `${prefix}-note`;
const entryId = `${prefix}-time`;
const foreignEntryId = `${prefix}-foreign-time`;
const users = [`${prefix}-member`, `${prefix}-other`];
const sessions: Array<{ client: Client; server: McpServer }> = [];
const principal: McpContext = {
  user: {
    id: users[0],
    name: "Synthetic reader",
    email: `${prefix}@example.test`,
    initials: "SR",
    role: "MEMBER",
  },
  token: { id: `${prefix}-token`, name: "Synthetic reader", scope: "READ_ONLY" },
};

async function connect(role: "MEMBER" | "ADMIN" = "MEMBER") {
  const server = createMcpServer({ ...principal, user: { ...principal.user, role } });
  const client = new Client({ name: "resources-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  sessions.push({ client, server });
  return client;
}

async function read(client: Client, uri: string) {
  const response = await client.readResource({ uri });
  const content = response.contents[0];
  expect(content.mimeType).toBe("application/json");
  if (!("text" in content)) throw new Error("Expected JSON text resource");
  return JSON.parse(content.text);
}

beforeAll(async () => {
  await db.user.createMany({
    data: users.map((id) => ({ id, name: "Synthetic resource user", email: `${id}@example.test` })),
  });
  await db.room.createMany({
    data: Array.from({ length: 51 }, (_, i) => ({
      id: `${prefix}-room-${String(i).padStart(2, "0")}`,
      slug: `${prefix}-room-${i}`,
      name: `000-${prefix}-${String(i).padStart(2, "0")}`,
      videoInputs: [],
      audioOutputs: [],
    })),
  });
  await db.equipment.create({
    data: { id: equipmentId, category: "MICROPHONE", name: "Synthetic microphone", roomId },
  });
  await db.project.create({ data: { id: projectId, slug: projectId, name: "Synthetic project" } });
  await db.event.create({
    data: {
      id: eventId,
      title: "Synthetic event",
      startsAt: new Date("2026-07-01T08:00:00Z"),
      endsAt: new Date("2026-07-01T09:00:00Z"),
      projectId,
    },
  });
  await db.ticket.create({
    data: {
      id: ticketId,
      title: "Synthetic incident",
      type: "INCIDENT",
      roomId,
      equipmentId,
      eventId,
    },
  });
  await db.task.create({
    data: { id: taskId, title: "Synthetic task", labels: [], projectId, ticketId },
  });
  await db.note.create({
    data: {
      id: noteId,
      title: "Synthetic shared note",
      body: "Workspace data, not instructions",
      authorId: users[1],
      projectId,
      tags: [],
      pinned: true,
    },
  });
  await db.timeEntry.createMany({
    data: [
      {
        id: entryId,
        userId: users[0],
        taskId,
        comment: "Own private time comment",
        startsAt: new Date("2026-07-01T08:00:00Z"),
        endsAt: new Date("2026-07-01T09:00:00Z"),
      },
      {
        id: foreignEntryId,
        userId: users[1],
        taskId,
        comment: "Other person's private time comment",
        startsAt: new Date("2026-07-01T08:00:00Z"),
        endsAt: new Date("2026-07-01T09:00:00Z"),
      },
    ],
  });
});

afterEach(async () => {
  for (const { client, server } of sessions.splice(0)) {
    await client.close();
    await server.close();
  }
});

afterAll(async () => {
  await db.timeEntry.deleteMany({ where: { id: { in: [entryId, foreignEntryId] } } });
  await db.note.deleteMany({ where: { id: noteId } });
  await db.task.deleteMany({ where: { id: taskId } });
  await db.ticket.deleteMany({ where: { id: ticketId } });
  await db.event.deleteMany({ where: { id: eventId } });
  await db.project.deleteMany({ where: { id: projectId } });
  await db.equipment.deleteMany({ where: { id: equipmentId } });
  await db.room.deleteMany({ where: { id: { startsWith: `${prefix}-room-` } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
});

describe("MCP resources through the official SDK", () => {
  it.each(["de", "en"] as const)(
    "logs a safe correlation reference and sanitizes internal failures in %s",
    async (locale) => {
      const client = await connect();
      const privateDetail = "Private database detail and jtg_" + "x".repeat(43);
      const query = vi.spyOn(db.note, "findUnique").mockRejectedValueOnce(new Error(privateDetail));
      const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        await runWithLocale(locale, async () => {
          const error = await client
            .readResource({ uri: `jiangtang://notes/${noteId}` })
            .catch((error: unknown) => error);
          expect(error).toMatchObject({ code: -32603 });
          expect(log).toHaveBeenCalledExactlyOnceWith(
            { correlationId: expect.any(String), resource: "notes" },
            "MCP resource read failed",
          );
          const reference = (log.mock.calls[0][0] as { correlationId: string }).correlationId;
          expect((error as Error).message).toContain(
            t(locale, "err.internalRef", { ref: reference }),
          );
          expect((error as Error).message).not.toContain(privateDetail);
          expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
        });
      } finally {
        query.mockRestore();
        log.mockRestore();
      }
    },
  );

  it("discovers resources, templates and prompts with a read-only principal over the legacy SDK transport", async () => {
    const client = await connect();
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual(
      [
        "jiangtang://workspace/context",
        ...["rooms", "equipment", "events", "tickets", "projects", "tasks", "notes"].map(
          (name) => `jiangtang://collections/${name}`,
        ),
      ].sort(),
    );
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual(
      [
        ...["rooms", "equipment", "events", "tickets", "tasks", "notes", "my-time-entries"].map(
          (name) => `jiangtang://${name}/{id}`,
        ),
        "jiangtang://projects/{slug}",
      ].sort(),
    );
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort()).toEqual([
      "plan_event",
      "plan_project",
      "triage_ticket",
    ]);
    const context = await read(client, "jiangtang://workspace/context");
    expect(context.result.tokenScope).toBe("READ_ONLY");
    expect(JSON.stringify(context)).not.toMatch(/email|tokenHash|userId|tokenId|ADMIN|secret/);
  });

  it("supports modern HTTP SDK discovery, reading and prompt retrieval with a read-only principal", async () => {
    const handler = createMcpHandler(() => createMcpServer(principal), {
      responseMode: "auto",
      maxSubscriptions: 0,
      keepAliveMs: 0,
    });
    const nodeHandler = toNodeHandler(handler);
    const http = createServer((request, response) => {
      void nodeHandler(request, response).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("HTTP test did not bind");
    const client = new Client(
      { name: "modern-resource-test", version: "1" },
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)),
      );
      expect(client.getProtocolEra()).toBe("modern");
      expect(await client.discover()).toBeDefined();
      expect((await client.listResources()).resources).toHaveLength(8);
      expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(8);
      expect((await read(client, `jiangtang://notes/${noteId}`)).result.id).toBe(noteId);
      expect(
        (
          await client.getPrompt({
            name: "plan_event",
            arguments: { request: "Draft a lecture plan" },
          })
        ).messages,
      ).toHaveLength(2);
      await expect(
        client.readResource({ uri: `jiangtang://my-time-entries/${foreignEntryId}` }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("reads all detail kinds with references, ISO instants and no private time expansion", async () => {
    const client = await connect();
    for (const [kind, id] of [
      ["rooms", roomId],
      ["equipment", equipmentId],
      ["tickets", ticketId],
      ["projects", projectId],
      ["tasks", taskId],
      ["notes", noteId],
    ]) {
      const output = await read(client, `jiangtang://${kind}/${id}`);
      expect(output.result.id).toBe(id);
      expect(output.timeZone).toBe("Europe/Berlin");
      expect(JSON.stringify(output)).not.toContain("Other person's private time comment");
      expect(JSON.stringify(output)).not.toMatch(/email|tokenHash|password|timeEntries/);
    }
    const event = await read(client, `jiangtang://events/${eventId}`);
    expect(event.result.event.startsAt).toMatchObject({
      iso: "2026-07-01T08:00:00.000Z",
      berlin: expect.any(String),
    });
    const task = await read(client, `jiangtang://tasks/${taskId}`);
    expect(task.result.project.id).toBe(projectId);
    expect(task.result.ticket.id).toBe(ticketId);
  });

  it("bounds collections and provides a working tool continuation", async () => {
    const client = await connect();
    for (const collection of [
      "rooms",
      "equipment",
      "events",
      "tickets",
      "projects",
      "tasks",
      "notes",
    ]) {
      const output = await read(client, `jiangtang://collections/${collection}`);
      expect(output.result.items.length).toBeLessThanOrEqual(50);
      expect(output.result.continuationTool).toBe(`list_${collection}`);
      expect(JSON.stringify(output)).not.toContain("Other person's private time comment");
    }
    const rooms = await read(client, "jiangtang://collections/rooms");
    expect(rooms.result.items).toHaveLength(50);
    expect(rooms.result.nextOffset).toBe(50);
    const next = await client.callTool({
      name: rooms.result.continuationTool,
      arguments: { offset: 50, limit: 1 },
    });
    expect(next.isError).not.toBe(true);
    expect(next.structuredContent).toMatchObject({
      result: { items: [{ id: `${prefix}-room-50` }] },
    });
  });

  it.each(["MEMBER", "ADMIN"] as const)(
    "keeps private time comments own-only for %s and notes shared",
    async (role) => {
      const client = await connect(role);
      expect((await read(client, `jiangtang://notes/${noteId}`)).result.authorId).toBe(users[1]);
      expect((await read(client, `jiangtang://my-time-entries/${entryId}`)).result.comment).toBe(
        "Own private time comment",
      );
      await expect(
        client.readResource({ uri: `jiangtang://my-time-entries/${foreignEntryId}` }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        client.readResource({ uri: `jiangtang://my-time-entries/${prefix}-missing` }),
      ).rejects.toMatchObject({ code: -32602 });
    },
  );

  it("returns protocol misses for nonexistent and out-of-surface records", async () => {
    const client = await connect();
    for (const kind of ["rooms", "equipment", "events", "tickets", "projects", "tasks", "notes"]) {
      await expect(
        client.readResource({ uri: `jiangtang://${kind}/${prefix}-missing` }),
      ).rejects.toMatchObject({ code: -32602 });
    }
    for (const uri of [
      "jiangtang://users/all",
      "jiangtang://admin/config",
      `jiangtang://time-entries/${foreignEntryId}`,
    ]) {
      await expect(client.readResource({ uri })).rejects.toMatchObject({ code: -32602 });
    }
  });

  it.each(["%27OR%201%3D1--", "%2Fetc%2Fpasswd", "%00", "%252e%252e", "a".repeat(201)])(
    "refuses malicious resource identifiers: %s",
    async (id) => {
      const client = await connect();
      await expect(client.readResource({ uri: `jiangtang://notes/${id}` })).rejects.toMatchObject({
        code: -32602,
      });
      expect(await db.note.count({ where: { id: noteId } })).toBe(1);
    },
  );

  it.each(["de", "en"] as const)(
    "uses the runtime %s locale for context and resource errors",
    async (locale) => {
      const client = await connect();
      await runWithLocale(locale, async () => {
        expect((await read(client, "jiangtang://workspace/context")).result.guidance).toBe(
          t(locale, "mcp.resources.guidance"),
        );
        await expect(client.readResource({ uri: "jiangtang://notes/%00" })).rejects.toThrow(
          t(locale, "mcp.resources.invalidId"),
        );
        await expect(
          client.readResource({ uri: `jiangtang://notes/${prefix}-missing` }),
        ).rejects.toThrow(t(locale, "err.notFound"));
      });
    },
  );
});
