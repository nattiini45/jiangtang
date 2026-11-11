import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { createMcpServer } from "~/lib/mcp/server.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";

const run = `ticket-actions-${crypto.randomUUID()}`;
const ids: string[] = [];
const sessions: Array<{ client: Client; server: McpServer }> = [];
const context: McpContext = {
  user: {
    id: "",
    name: "Synthetic ticket agent",
    email: `${run}@example.test`,
    initials: "TA",
    role: "MEMBER",
  },
  token: { id: run, name: "Synthetic ticket client", scope: "READ_WRITE" },
};

async function connect(scope: McpContext["token"]["scope"]) {
  const server = createMcpServer({ ...context, token: { ...context.token, scope } });
  const client = new Client({ name: run, version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  sessions.push({ client, server });
  return client;
}

function success(result: CallToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return (result.structuredContent as { result: Record<string, unknown> }).result;
}

function failure(result: CallToolResult, status: number) {
  expect(result.isError).toBe(true);
  const content = result.content[0];
  if (content.type !== "text") throw new Error("Expected JSON text");
  const body = JSON.parse(content.text);
  expect(body.status).toBe(status);
  return body.detail;
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { name: context.user.name, email: context.user.email },
  });
  context.user.id = user.id;
});

afterAll(async () => {
  for (const { client, server } of sessions) {
    await client.close();
    await server.close();
  }
  await db.ticket.deleteMany({ where: { id: { in: ids } } });
  await db.user.delete({ where: { id: context.user.id } });
  await db.$disconnect();
});

describe.each(["en", "de"] as const)("ticket MCP actions in %s", (locale) => {
  it("publishes ticket-only discovery for both scopes and keeps permissions separate from legality", async () => {
    const ticket = await createTicket(
      { id: context.user.id },
      {
        title: `${run} discovery`,
        type: "REPAIR",
        status: "RESOLVED",
        resolution: "Synthetic repair",
        assigneeIds: [],
      },
    );
    ids.push(ticket.id);
    for (const scope of ["READ_ONLY", "READ_WRITE"] as const) {
      const client = await connect(scope);
      await runWithLocale(locale, async () => {
        const tools = (await client.listTools()).tools;
        expect(tools.filter((tool) => tool.annotations?.readOnlyHint)).toHaveLength(46);
        expect(tools.filter((tool) => !tool.annotations?.readOnlyHint)).toHaveLength(74);
        const definition = tools.find((tool) => tool.name === "get_allowed_actions");
        expect(definition?.annotations?.readOnlyHint).toBe(true);
        const allowed = success(
          await client.callTool({
            name: "get_allowed_actions",
            arguments: { entityType: "ticket", id: ticket.id },
          }),
        );
        expect(allowed).toMatchObject({
          entity: "ticket",
          id: ticket.id,
          currentState: "RESOLVED",
          allowedTransitions: ["OPEN", "IN_PROGRESS"],
          allowedActions: [
            { target: "OPEN", requiredFields: [], allowed: true },
            { target: "IN_PROGRESS", requiredFields: [], allowed: true },
          ],
          canWrite: scope === "READ_WRITE",
          requiresConfirmation: true,
          permissionReason:
            scope === "READ_WRITE"
              ? null
              : { code: "READ_ONLY", message: t(locale, "err.mcp.writeTokenRequired") },
        });
        expect(
          (
            await client.callTool({
              name: "get_allowed_actions",
              arguments: { entityType: "task", id: ticket.id },
            })
          ).isError,
        ).toBe(true);
        failure(
          await client.callTool({
            name: "get_allowed_actions",
            arguments: { entityType: "ticket", id: `${run}-missing` },
          }),
          404,
        );
        if (scope === "READ_ONLY") {
          const denied = failure(
            await client.callTool({
              name: "transition_ticket",
              arguments: { id: ticket.id, input: { status: "OPEN" }, confirm: true },
            }),
            403,
          );
          expect(denied.message).toBe(t(locale, "err.mcp.writeTokenRequired"));
        }
      });
    }
    expect(
      await db.activityLog.count({ where: { entityType: "ticket", entityId: ticket.id } }),
    ).toBe(1);
  });

  it("projects next actions on reads, resources and every ticket mutation, with localized structured refusals", async () => {
    const client = await connect("READ_WRITE");
    await runWithLocale(locale, async () => {
      const created = success(
        await client.callTool({
          name: "create_ticket",
          arguments: { input: { title: `${run} workflow`, type: "REQUEST" } },
        }),
      );
      const id = String(created.id);
      ids.push(id);
      expect(created.allowedTransitions).toEqual(["IN_PROGRESS", "RESOLVED", "CANCELLED"]);
      expect(created.allowedActions).toContainEqual({
        target: "RESOLVED",
        labelKey: "tickets.detail.resolve",
        requiredFields: ["resolution"],
        allowed: true,
      });
      const detail = success(await client.callTool({ name: "get_ticket", arguments: { id } }));
      expect(detail.allowedActions).toEqual(created.allowedActions);
      const resource = (await client.readResource({ uri: `jiangtang://tickets/${id}` }))
        .contents[0];
      if (!("text" in resource)) throw new Error("Expected text resource");
      expect(JSON.parse(resource.text).result.allowedTransitions).toEqual(
        created.allowedTransitions,
      );
      const updated = success(
        await client.callTool({
          name: "update_ticket",
          arguments: { id, input: { title: `${run} edited`, type: "REPAIR" } },
        }),
      );
      expect(updated.allowedActions).toEqual(created.allowedActions);
      for (const name of ["transition_ticket", "move_ticket"] as const) {
        const args =
          name === "transition_ticket"
            ? { id, input: { status: "RESOLVED" } }
            : { id, lane: "DONE", resolution: " \t " };
        const rejected = failure(
          await client.callTool({ name, arguments: { ...args, confirm: true } }),
          422,
        );
        expect(rejected).toMatchObject({
          error: "ValidationError",
          fieldErrors: { resolution: [t(locale, "work.err.ticket.resolutionRequired")] },
          formErrors: [t(locale, "work.err.ticket.resolutionRequired")],
          transition: {
            entity: "ticket",
            currentState: "OPEN",
            attemptedTarget: "RESOLVED",
            allowedTransitions: created.allowedTransitions,
            reason: {
              code: "RESOLUTION_REQUIRED",
              message: t(locale, "work.err.ticket.resolutionRequired"),
            },
          },
        });
      }
      const unsupported = failure(
        await client.callTool({
          name: "move_ticket",
          arguments: { id, lane: "IN_REVIEW", confirm: true },
        }),
        422,
      );
      expect(unsupported.transition).toMatchObject({
        currentState: "OPEN",
        attemptedTarget: "IN_REVIEW",
        reason: { code: "UNSUPPORTED_LANE" },
      });
      const unconfirmed = await client.callTool({
        name: "transition_ticket",
        arguments: { id, input: { status: "IN_PROGRESS" } },
      });
      expect(unconfirmed.isError).toBe(true);
      const invalid = await client.callTool({
        name: "transition_ticket",
        arguments: { id, input: { status: "BOGUS" }, confirm: true },
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid.content)).not.toContain('"transition":');
      expect(await db.activityLog.count({ where: { entityType: "ticket", entityId: id } })).toBe(2);
      expect((await db.ticket.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
      const started = success(
        await client.callTool({
          name: "transition_ticket",
          arguments: { id, input: { status: "IN_PROGRESS" }, confirm: true },
        }),
      );
      expect(started.allowedTransitions).toEqual(["OPEN", "RESOLVED", "CANCELLED"]);
      const reopened = success(
        await client.callTool({
          name: "move_ticket",
          arguments: { id, lane: "BACKLOG", confirm: true },
        }),
      );
      expect(reopened.allowedTransitions).toEqual(created.allowedTransitions);
      const resolved = success(
        await client.callTool({
          name: "move_ticket",
          arguments: { id, lane: "DONE", resolution: "Synthetic fix", confirm: true },
        }),
      );
      expect(resolved.allowedTransitions).toEqual(["OPEN", "IN_PROGRESS"]);
      expect(resolved.resolution).toBe("Synthetic fix");
      const before = await db.activityLog.count({ where: { entityType: "ticket", entityId: id } });
      const noop = success(
        await client.callTool({
          name: "move_ticket",
          arguments: { id, lane: "DONE", confirm: true },
        }),
      );
      expect(noop.allowedTransitions).toEqual(resolved.allowedTransitions);
      const illegal = failure(
        await client.callTool({
          name: "transition_ticket",
          arguments: { id, input: { status: "CANCELLED" }, confirm: true },
        }),
        422,
      );
      expect(illegal.transition).toMatchObject({
        currentState: "RESOLVED",
        attemptedTarget: "CANCELLED",
        allowedTransitions: ["OPEN", "IN_PROGRESS"],
        reason: {
          code: "INVALID_TRANSITION",
          message: t(locale, "work.err.ticket.invalidTransition", {
            from: "RESOLVED",
            to: "CANCELLED",
          }),
        },
      });
      expect(await db.activityLog.count({ where: { entityType: "ticket", entityId: id } })).toBe(
        before,
      );
    });
  });
});
