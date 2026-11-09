import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createPersonalAccessToken } from "~/domains/api-tokens/api-tokens.server";
import { db } from "~/lib/db.server";
import { register } from "~/lib/mcp/mcp.boot.server";

const prefix = `mcp-http-mutations-${crypto.randomUUID()}`;
const tokenName = "Synthetic HTTP scheduling agent";
const interval = {
  startsAt: "2026-07-01T10:00:17.250+02:00",
  endsAt: "2026-07-01T11:00:29.750+02:00",
};

describe("MCP mutations through the official HTTP SDK", () => {
  let server: Server | undefined;
  let writer: Client;
  let reader: Client;
  let user: { id: string; name: string; email: string; role: "MEMBER" };
  let writerTokenId: string;
  let campusId: string | undefined;
  let roomId: string | undefined;
  const clients: Client[] = [];

  beforeAll(async () => {
    const created = await db.user.create({
      data: {
        name: "Synthetic HTTP mutation member",
        email: `${prefix}@example.test`,
        role: "MEMBER",
      },
    });
    user = { ...created, role: "MEMBER" };
    const writeToken = await createPersonalAccessToken(user, {
      name: tokenName,
      scope: "READ_WRITE",
    });
    writerTokenId = writeToken.record.id;
    const readToken = await createPersonalAccessToken(user, {
      name: "Synthetic HTTP observer",
      scope: "READ_ONLY",
    });
    campusId = (await db.campus.create({ data: { name: prefix, slug: prefix } })).id;
    roomId = (
      await db.room.create({
        data: { campusId, name: `${prefix} room`, slug: prefix },
      })
    ).id;

    const app = express();
    register(app);
    const listener = createServer(app);
    server = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.removeListener("error", reject);
        resolve();
      });
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("HTTP test did not bind");
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    for (const token of [writeToken.token, readToken.token]) {
      const client = new Client({ name: "jiangtang-http-mutations-test", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
    }
    [writer, reader] = clients;
  });

  afterAll(async () => {
    try {
      const closed = await Promise.allSettled(clients.map((client) => client.close()));
      const failed = closed.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      try {
        const listener = server;
        if (listener?.listening) {
          await new Promise<void>((resolve, reject) => {
            listener.close((error) => (error ? reject(error) : resolve()));
            listener.closeAllConnections();
          });
        }
      } finally {
        const events = await db.event.findMany({ where: { title: { startsWith: prefix } } });
        const eventIds = events.map((event) => event.id);
        await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
        await db.calendarOutbox.deleteMany({
          where: { payload: { path: ["title"], string_starts_with: prefix } },
        });
        await db.event.deleteMany({ where: { id: { in: eventIds } } });
        await db.task.deleteMany({ where: { title: { startsWith: prefix } } });
        if (roomId) await db.room.delete({ where: { id: roomId } });
        if (campusId) await db.campus.delete({ where: { id: campusId } });
        if (user) await db.user.delete({ where: { id: user.id } });
      }
    }
  });

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    return client.callTool({ name, arguments: args });
  }

  async function success(client: Client, name: string, args: Record<string, unknown>) {
    const result = await call(client, name, args);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ timeZone: "Europe/Berlin" });
    return (result.structuredContent as { result: Record<string, unknown> }).result;
  }

  it("persists task and event/booking writes with the connecting member and named token audit", async () => {
    const task = await success(writer, "create_task", {
      input: { title: `${prefix} task`, dueAt: "2026-07-02" },
    });
    expect(await db.task.findUniqueOrThrow({ where: { id: String(task.id) } })).toMatchObject({
      title: `${prefix} task`,
      createdById: user.id,
      dueAt: new Date("2026-07-01T22:00:00Z"),
    });
    expect(await success(writer, "get_task", { id: task.id })).toMatchObject({ id: task.id });

    const event = await success(writer, "create_event_with_booking", {
      input: { title: `${prefix} event`, ...interval },
      booking: { roomId, ...interval },
    });
    const persisted = await db.event.findUniqueOrThrow({ where: { id: String(event.id) } });
    expect(persisted).toMatchObject({
      title: `${prefix} event`,
      startsAt: new Date("2026-07-01T08:00:17.250Z"),
      endsAt: new Date("2026-07-01T09:00:29.750Z"),
    });
    const bookings = await db.eventRoomBooking.findMany({ where: { eventId: persisted.id } });
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({
      roomId,
      cancelled: false,
      startsAt: persisted.startsAt,
      endsAt: persisted.endsAt,
    });
    expect(event.bookings).toEqual([expect.objectContaining({ id: bookings[0].id, roomId })]);
    const logs = await db.activityLog.findMany({
      where: { entityId: { in: [String(task.id), persisted.id, bookings[0].id] } },
    });
    expect(logs.map((log) => log.action).sort()).toEqual([
      "EventCreated",
      "RoomBooked",
      "TaskCreated",
    ]);
    for (const log of logs) {
      expect(log.actorId).toBe(user.id);
      expect(log.actorSnapshot).toMatchObject({
        name: user.name,
        email: user.email,
        via: `via MCP (${tokenName})`,
        tokenId: writerTokenId,
      });
    }
    expect(
      (await db.personalAccessToken.findUniqueOrThrow({ where: { id: writerTokenId } })).lastUsedAt,
    ).not.toBeNull();
  });

  it("discovers resources and prompts through authenticated HTTP with each real token scope", async () => {
    const task = await success(writer, "create_task", {
      input: { title: `${prefix} resource detail` },
    });
    for (const [client, scope] of [
      [reader, "READ_ONLY"],
      [writer, "READ_WRITE"],
    ] as const) {
      expect((await client.listResources()).resources).toHaveLength(8);
      expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(8);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort()).toEqual([
        "plan_event",
        "plan_project",
        "triage_ticket",
      ]);
      const context = await client.readResource({ uri: "jiangtang://workspace/context" });
      expect(context.contents[0]).toMatchObject({
        text: expect.stringContaining(`"tokenScope":"${scope}"`),
      });
      const detail = await client.readResource({ uri: `jiangtang://tasks/${String(task.id)}` });
      expect(detail.contents[0]).toMatchObject({
        text: expect.stringContaining(`"id":"${String(task.id)}"`),
      });
      const prompt = await client.getPrompt({
        name: "plan_event",
        arguments: { request: "Propose a synthetic lecture without booking it" },
      });
      expect(prompt.messages).toHaveLength(2);
      expect(prompt.messages[0].content).toMatchObject({
        type: "text",
        text: expect.stringContaining("create_event_with_booking"),
      });
    }
  });

  it("returns a useful overlap conflict and rolls back the losing event, booking, outbox and audit", async () => {
    const times = {
      startsAt: "2026-07-02T10:00:00+02:00",
      endsAt: "2026-07-02T11:00:00+02:00",
    };
    const winner = await success(writer, "create_event_with_booking", {
      input: { title: `${prefix} winning event`, ...times },
      booking: { roomId, ...times },
    });
    const booking = await db.eventRoomBooking.findFirstOrThrow({
      where: { eventId: String(winner.id) },
    });
    const before = await db.activityLog.count({ where: { actorId: user.id } });
    const rejectedTitle = `${prefix} rejected atomic event`;
    const result = await call(writer, "create_event_with_booking", {
      input: { title: rejectedTitle, ...times },
      booking: { roomId, ...times },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"status":409') }),
    ]);
    const conflict = JSON.stringify(result.content);
    for (const detail of [
      "BookingConflict",
      String(winner.id),
      String(winner.label),
      booking.id,
      "2026-07-02T08:00:00.000Z",
      "2026-07-02T09:00:00.000Z",
    ]) {
      expect(conflict).toContain(detail);
    }
    expect(await db.event.count({ where: { title: rejectedTitle } })).toBe(0);
    expect(
      await db.eventRoomBooking.findMany({
        where: { roomId, startsAt: booking.startsAt, endsAt: booking.endsAt },
        select: { id: true, eventId: true },
      }),
    ).toEqual([{ id: booking.id, eventId: winner.id }]);
    expect(
      await db.calendarOutbox.count({
        where: { payload: { path: ["title"], equals: rejectedTitle } },
      }),
    ).toBe(0);
    expect(await db.activityLog.count({ where: { actorId: user.id } })).toBe(before);
    expect(
      await db.activityLog.count({
        where: { data: { path: ["title"], equals: rejectedTitle } },
      }),
    ).toBe(0);
  });

  it("allows a real read-only token to read but refuses creates and confirmed deletes", async () => {
    const task = await success(writer, "create_task", {
      input: { title: `${prefix} read-only target` },
    });
    expect(await success(reader, "get_task", { id: task.id })).toMatchObject({
      id: task.id,
      title: `${prefix} read-only target`,
    });
    const before = await db.activityLog.count({ where: { actorId: user.id } });
    for (const [name, args] of [
      ["create_task", { input: { title: `${prefix} forbidden task` } }],
      [
        "create_event_with_booking",
        {
          input: { title: `${prefix} forbidden event`, ...interval },
          booking: { roomId, ...interval },
        },
      ],
      ["delete_task", { id: task.id, confirm: true }],
    ] as const) {
      const result = await call(reader, name, args);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining('"status":403') }),
      ]);
    }
    expect(await db.task.findUnique({ where: { id: String(task.id) } })).not.toBeNull();
    expect(await db.task.count({ where: { title: `${prefix} forbidden task` } })).toBe(0);
    expect(await db.event.count({ where: { title: `${prefix} forbidden event` } })).toBe(0);
    expect(await db.activityLog.count({ where: { actorId: user.id } })).toBe(before);
  });

  it("requires literal destructive confirmation before deleting a real task", async () => {
    const task = await success(writer, "create_task", {
      input: { title: `${prefix} confirmation target` },
    });
    const before = await db.activityLog.count({ where: { actorId: user.id } });
    for (const confirm of [undefined, false, "true", 1, { confirm: true }]) {
      const result = await call(writer, "delete_task", {
        id: task.id,
        ...(confirm === undefined ? {} : { confirm }),
      });
      expect(result.isError, `confirm=${JSON.stringify(confirm)}`).toBe(true);
      expect(await db.task.findUnique({ where: { id: String(task.id) } })).not.toBeNull();
      expect(await db.activityLog.count({ where: { actorId: user.id } })).toBe(before);
    }
    await success(writer, "delete_task", { id: task.id, confirm: true });
    expect(await db.task.findUnique({ where: { id: String(task.id) } })).toBeNull();
    expect(
      await db.activityLog.findMany({
        where: { entityId: String(task.id), action: "TaskDeleted" },
      }),
    ).toEqual([
      expect.objectContaining({
        actorId: user.id,
        actorSnapshot: expect.objectContaining({
          via: `via MCP (${tokenName})`,
          tokenId: writerTokenId,
        }),
      }),
    ]);
  });
});
