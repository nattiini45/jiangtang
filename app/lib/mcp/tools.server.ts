import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toErrorResponse } from "~/lib/errors.server";
import { formatDateTime } from "~/i18n/format";
import { currentLocale } from "~/i18n/request-locale.server";
import { Prisma } from "~/generated/prisma/client";
import type { McpContext } from "./types.server";

export function serializeMcp(value: unknown): unknown {
  if (value instanceof Date) {
    return { iso: value.toISOString(), berlin: formatDateTime(currentLocale(), value) };
  }
  if (typeof value === "bigint") return value.toString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(serializeMcp);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeMcp(entry)]),
    );
  }
  return value;
}

export async function mcpError(error: unknown): Promise<CallToolResult> {
  const response = toErrorResponse(error);
  const text = await response.text();
  let detail: unknown;
  try {
    detail = JSON.parse(text);
  } catch {
    detail = { message: text || response.statusText };
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ status: response.status, detail }) }],
  };
}

export function registerTool<S extends z.ZodType>(
  server: McpServer,
  context: McpContext,
  definition: {
    name: string;
    description: string;
    schema: S;
    role?: "ADMIN";
    write?: boolean;
    destructive?: boolean;
  },
  handler: (input: z.output<S>, context: McpContext) => Promise<unknown>,
): void {
  const inputSchema: z.ZodType = definition.schema;
  server.registerTool(
    definition.name,
    {
      description: definition.description,
      inputSchema,
      annotations: {
        readOnlyHint: !definition.write,
        destructiveHint: Boolean(definition.destructive),
        openWorldHint: false,
      },
    },
    async (args: unknown) => {
      try {
        if (definition.role === "ADMIN" && context.user.role !== "ADMIN") {
          throw new Response("This operation requires the ADMIN role.", { status: 403 });
        }
        if (definition.write && context.token.scope !== "READ_WRITE") {
          throw new Response("This token is read-only. A read-write token is required.", {
            status: 403,
          });
        }
        const input = definition.schema.parse(args);
        if (definition.destructive && (!input || Reflect.get(input, "confirm") !== true)) {
          throw new Response("Set confirm to true to perform this destructive operation.", {
            status: 422,
          });
        }
        const result = serializeMcp(await handler(input, context));
        const structuredContent = { result, timeZone: "Europe/Berlin" };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      } catch (error) {
        return mcpError(error);
      }
    },
  );
}
