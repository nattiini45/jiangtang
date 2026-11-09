import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { t, type MessageKey } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";
import { registerTool } from "~/lib/mcp/tools.server";
import { registerReadTools } from "~/lib/mcp/read-tools.server";
import { registerEventWrites } from "~/lib/mcp/event-writes.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { attachmentUrl } from "~/domains/attachments/attachment-url.server";
import {
  attachmentTransferSchema,
  decodeAttachmentBase64,
} from "~/domains/attachments/attachments.transfer.server";
import { toErrorResponse } from "~/lib/errors.server";

const member: McpContext = {
  user: {
    id: "synthetic-member",
    name: "Synthetic member",
    email: "mcp-locales@example.test",
    initials: "SM",
    role: "MEMBER",
  },
  token: { id: "synthetic-token", name: "Synthetic agent", scope: "READ_WRITE" },
};
const from = "2026-07-01T10:00:00Z";
const to = "2026-07-01T11:00:00Z";

describe.each(["en", "de"] as const)("MCP runtime errors in %s", (locale) => {
  it("localizes permission and confirmation errors without invoking handlers", async () => {
    const server = new McpServer({ name: "locale-tests", version: "1" });
    let calls = 0;
    const definitions = [
      { name: "admin", role: "ADMIN" as const },
      { name: "write", write: true },
      { name: "confirm", destructive: true },
    ];
    for (const definition of definitions) {
      registerTool(
        server,
        { ...member, token: { ...member.token, scope: "READ_ONLY" } },
        { ...definition, description: "Stable English metadata", schema: z.object({}) },
        async () => {
          calls++;
          return {};
        },
      );
    }
    const client = new Client({ name: "locale-tests", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      await runWithLocale(locale, async () => {
        for (const [name, status, key] of [
          ["admin", 403, "err.mcp.adminRequired"],
          ["write", 403, "err.mcp.writeTokenRequired"],
          ["confirm", 422, "err.mcp.confirmRequired"],
        ] as const) {
          const result = await client.callTool({ name, arguments: {} });
          expect(result.isError).toBe(true);
          expect(result.content).toEqual([
            { type: "text", text: JSON.stringify({ status, detail: { message: t(locale, key) } }) },
          ]);
        }
      });
      expect(calls).toBe(0);
      expect(
        (await client.listTools()).tools.every(
          (tool) => tool.description === "Stable English metadata",
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("localizes read and write refinements through the MCP error boundary", async () => {
    const server = new McpServer({ name: "locale-validation-tests", version: "1" });
    registerReadTools(server, member);
    registerEventWrites(server, member);
    const client = new Client({ name: "locale-validation-tests", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const cases: [string, Record<string, unknown>, MessageKey][] = [
      ["list_room_bookings", { from: to, to: from }, "err.mcp.toAfterFrom"],
      ["list_equipment_allocations", { from: to, to: from }, "err.mcp.toAfterFrom"],
      ["list_events", { from: to, to: from }, "err.mcp.toAfterFrom"],
      [
        "check_booking_conflicts",
        { kind: "room", id: "room-id", startsAt: to, endsAt: from },
        "err.mcp.endsAfterStarts",
      ],
      ["find_free_slot", { from, to, durationMinutes: 30 }, "err.mcp.resourceRequired"],
      [
        "find_free_slot",
        { from, to, durationMinutes: 61, roomIds: ["room-id"] },
        "err.mcp.slotWindow",
      ],
      ["list_tasks", { dueFrom: to, dueTo: from }, "err.mcp.dueWindow"],
      ["list_attachments", {}, "err.mcp.attachmentTarget"],
      [
        "create_event",
        { input: { title: "Synthetic title", startsAt: from, endsAt: to, status: "CANCELLED" } },
        "err.mcp.createActiveEvent",
      ],
      [
        "create_ticket",
        { input: { title: "Synthetic title", status: "CANCELLED" } },
        "err.mcp.useTransitionTicket",
      ],
    ];
    try {
      await runWithLocale(locale, async () => {
        for (const [name, args, key] of cases) {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError, name).toBe(true);
          const content = result.content[0];
          if (content.type !== "text") throw new Error("Expected text error");
          const body = JSON.parse(content.text);
          expect(body.status, name).toBe(422);
          expect(JSON.stringify(body.detail), name).toContain(t(locale, key));
          expect(content.text).not.toContain(key);
        }
        const result = await client.callTool({
          name: "get_running_timer",
          arguments: { userId: "another-user" },
        });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          {
            type: "text",
            text: JSON.stringify({
              status: 403,
              detail: { message: t(locale, "err.mcp.adminRequired") },
            }),
          },
        ]);
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("localizes attachment responses and source validation while preserving status", async () => {
    await runWithLocale(locale, async () => {
      for (const [action, key] of [
        [() => attachmentUrl("not a URL"), "err.mcp.attachmentUrlInvalid"],
        [() => attachmentUrl("http://example.com/image.png"), "err.mcp.attachmentUrlRequirements"],
        [() => attachmentUrl("https://127.0.0.1/image.png"), "err.mcp.attachmentUrlPublic"],
        [() => attachmentUrl("https://image.local/image.png"), "err.mcp.attachmentUrlLocal"],
        [() => decodeAttachmentBase64("invalid"), "err.mcp.attachmentBase64"],
      ] as const) {
        let error: unknown;
        try {
          action();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Response);
        const response = error as Response;
        expect(response.status).toBe(422);
        expect(await response.text()).toBe(t(locale, key));
      }
      const parsed = attachmentTransferSchema.safeParse({
        category: "ROOM",
        roomId: "synthetic-room",
        filename: "synthetic.png",
        contentType: "image/png",
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Expected source validation error");
      const response = toErrorResponse(parsed.error);
      expect(response.status).toBe(422);
      expect((await response.json()).fieldErrors.base64).toEqual([
        t(locale, "err.mcp.attachmentSource"),
      ]);
    });
  });

  it("keeps conflict IDs, user titles and ISO instants unchanged", () => {
    const values = {
      eventTitle: "Synthetic event title",
      eventId: "synthetic-event-id",
      reservationId: "synthetic-reservation-id",
      startsAt: from,
      endsAt: to,
    };
    for (const key of [
      "err.mcp.bookingConflictDetail",
      "err.mcp.allocationConflictDetail",
    ] as const) {
      const message = t(locale, key, values);
      for (const value of Object.values(values)) expect(message).toContain(value);
      expect(message).not.toMatch(/\{\w+\}/);
      expect(message).toContain(
        locale === "en"
          ? key.includes("booking")
            ? "booking"
            : "allocation"
          : key.includes("booking")
            ? "Raumbuchung"
            : "Gerätezuweisung",
      );
    }
  });
});
