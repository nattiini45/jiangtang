import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { createMcpServer } from "~/lib/mcp/server.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";
import { taskActionMetadata } from "~/domains/tasks/tasks.transitions";
import { projectActionMetadata } from "~/domains/projects/projects.transitions";

const run = `work-actions-${crypto.randomUUID()}`;
const taskIds: string[] = [];
const projectIds: string[] = [];
const sessions: Array<{ client: Client; server: McpServer }> = [];
const context: McpContext = {
  user: {
    id: "",
    name: "Synthetic work agent",
    email: `${run}@example.test`,
    initials: "WA",
    role: "MEMBER",
  },
  token: { id: run, name: "Synthetic work client", scope: "READ_WRITE" },
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
  context.user.id = (
    await db.user.create({ data: { name: context.user.name, email: context.user.email } })
  ).id;
});
afterAll(async () => {
  for (const { client, server } of sessions) {
    await client.close();
    await server.close();
  }
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.user.delete({ where: { id: context.user.id } });
  await db.$disconnect();
});

describe.each(["en", "de"] as const)("work MCP actions in %s", (locale) => {
  it("keeps discovery read-only, uses IDs for discovery and preserves slug-based project reads", async () => {
    const client = await connect("READ_WRITE");
    await runWithLocale(locale, async () => {
      const task = success(
        await client.callTool({
          name: "create_task",
          arguments: { input: { title: `${run} task`, status: "BLOCKED" } },
        }),
      );
      taskIds.push(String(task.id));
      const project = success(
        await client.callTool({
          name: "create_project",
          arguments: { input: { name: `${run} project`, status: "CANCELLED" } },
        }),
      );
      projectIds.push(String(project.id));
      for (const scope of ["READ_ONLY", "READ_WRITE"] as const) {
        const reader = await connect(scope);
        const tools = (await reader.listTools()).tools;
        expect(tools).toHaveLength(133);
        expect(
          tools.find((tool) => tool.name === "get_allowed_actions")?.annotations?.readOnlyHint,
        ).toBe(true);
        for (const entityType of ["task", "project"] as const) {
          const row = entityType === "task" ? task : project;
          const metadata =
            entityType === "task"
              ? taskActionMetadata("BLOCKED")
              : projectActionMetadata("CANCELLED");
          const actions = success(
            await reader.callTool({
              name: "get_allowed_actions",
              arguments: { entityType, id: row.id },
            }),
          );
          expect(actions).toEqual({
            entity: entityType,
            id: row.id,
            currentState: row.status,
            ...metadata,
            canWrite: scope === "READ_WRITE",
            permissionReason:
              scope === "READ_WRITE"
                ? null
                : { code: "READ_ONLY", message: t(locale, "err.mcp.writeTokenRequired") },
            requiresConfirmation: false,
          });
          const detail = success(
            await reader.callTool({
              name: `get_${entityType}`,
              arguments: entityType === "task" ? { id: row.id } : { slug: row.slug },
            }),
          );
          expect(detail).toMatchObject(metadata);
          const resource = (
            await reader.readResource({
              uri: `jiangtang://${entityType === "task" ? "tasks" : "projects"}/${entityType === "task" ? row.id : row.slug}`,
            })
          ).contents[0];
          if (!("text" in resource)) throw new Error("Expected text resource");
          expect(JSON.parse(resource.text).result).toMatchObject(metadata);
          failure(
            await reader.callTool({
              name: "get_allowed_actions",
              arguments: { entityType, id: `${run}-missing` },
            }),
            404,
          );
          if (scope === "READ_ONLY")
            failure(
              await reader.callTool({
                name: `set_${entityType}_status`,
                arguments: { id: row.id, status: entityType === "task" ? "DONE" : "COMPLETED" },
              }),
              403,
            );
        }
        failure(
          await reader.callTool({
            name: "get_allowed_actions",
            arguments: { entityType: "project", id: project.slug },
          }),
          404,
        );
        failure(
          await reader.callTool({
            name: "get_allowed_actions",
            arguments: { entityType: "project", id: task.id },
          }),
          404,
        );
      }
      expect(
        await db.activityLog.count({ where: { entityType: "task", entityId: String(task.id) } }),
      ).toBe(1);
      expect(
        await db.activityLog.count({
          where: { entityType: "project", entityId: String(project.id) },
        }),
      ).toBe(1);
    });
  });

  it("returns next actions on confirmation-free status/move calls and localized no-write transition errors", async () => {
    const client = await connect("READ_WRITE");
    await runWithLocale(locale, async () => {
      const task = success(
        await client.callTool({
          name: "create_task",
          arguments: { input: { title: `${run} mutate`, status: "TODO" } },
        }),
      );
      taskIds.push(String(task.id));
      const project = success(
        await client.callTool({
          name: "create_project",
          arguments: { input: { name: `${run} mutate`, status: "REQUESTED" } },
        }),
      );
      projectIds.push(String(project.id));
      for (const entityType of ["task", "project"] as const) {
        const row = entityType === "task" ? task : project;
        const target = entityType === "task" ? "DONE" : "COMPLETED";
        const metadata =
          entityType === "task" ? taskActionMetadata("DONE") : projectActionMetadata("COMPLETED");
        const updated = success(
          await client.callTool({
            name: `set_${entityType}_status`,
            arguments: { id: row.id, status: target },
          }),
        );
        expect(updated).toMatchObject({
          ...row,
          status: target,
          updatedAt: { iso: expect.any(String), berlin: expect.any(String) },
          ...(entityType === "task" ? { position: expect.any(String) } : {}),
          ...metadata,
        });
        const prior = await db.activityLog.findMany({
          where: { entityType, entityId: String(row.id) },
        });
        const rejected = failure(
          await client.callTool({
            name: `set_${entityType}_status`,
            arguments: { id: row.id, status: target },
          }),
          422,
        );
        const message = t(
          locale,
          entityType === "task" ? "work.err.task.statusAlready" : "work.err.project.statusAlready",
        );
        expect(rejected).toMatchObject({
          fieldErrors: { status: [message] },
          formErrors: [message],
          transition: {
            entity: entityType,
            currentState: target,
            attemptedTarget: target,
            ...metadata,
            reason: { code: "INVALID_TRANSITION", message },
          },
        });
        expect(
          await db.activityLog.findMany({ where: { entityType, entityId: String(row.id) } }),
        ).toEqual(prior);
        failure(
          await client.callTool({
            name: `set_${entityType}_status`,
            arguments: { id: `${run}-missing`, status: target },
          }),
          404,
        );
      }
      const moved = success(
        await client.callTool({ name: "move_task", arguments: { id: task.id, lane: "IN_REVIEW" } }),
      );
      expect(moved).toMatchObject({
        id: task.id,
        status: "IN_REVIEW",
        ...taskActionMetadata("IN_REVIEW"),
      });
      expect(
        (
          await client.callTool({
            name: "set_task_status",
            arguments: { id: task.id, status: "BOGUS" },
          })
        ).isError,
      ).toBe(true);
      expect(
        (await client.callTool({ name: "delete_task", arguments: { id: task.id } })).isError,
      ).toBe(true);
      expect(
        (await client.callTool({ name: "delete_project", arguments: { id: project.id } })).isError,
      ).toBe(true);
    });
  });
});
