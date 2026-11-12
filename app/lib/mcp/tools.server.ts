import { fromJsonSchema, type JsonSchemaType, type McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { formatDateTime } from "~/i18n/format";
import { currentLocale, tr } from "~/i18n/request-locale.server";
import { Prisma } from "~/generated/prisma/client";
import type { McpContext } from "./types.server";

const inputSchemas = new Map<string, ReturnType<typeof fromJsonSchema>>();

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

export function withoutEquipmentKind<T extends object>(value: T): Omit<T, "kind" | "kindId"> {
  const {
    kind: _kind,
    kindId: _kindId,
    ...rest
  } = value as T & { kind?: unknown; kindId?: unknown };
  return rest;
}

export async function mcpError(error: unknown): Promise<CallToolResult> {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") error = new NotFoundError();
    else if (error.code === "P2003") {
      error = new ValidationError({}, [tr("err.mcp.reference")]);
    } else if (error.code === "P2002") {
      error = new Response(JSON.stringify({ error: "Conflict", message: tr("err.mcp.unique") }), {
        status: 409,
      });
    }
  }
  const response = toErrorResponse(error);
  if (response.status >= 500) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: response.status,
            detail: { error: "InternalServerError", message: tr("err.internal") },
          }),
        },
      ],
    };
  }
  const text = await response.text();
  let detail: unknown;
  try {
    detail = JSON.parse(text);
    if (
      detail &&
      typeof detail === "object" &&
      Reflect.get(detail, "error") === "InternalServerError"
    ) {
      detail = { error: "InternalServerError", message: tr("err.internal") };
    }
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
    openWorld?: boolean;
  },
  handler: (input: z.output<S>, context: McpContext) => Promise<unknown>,
): void {
  const jsonSchema = z.toJSONSchema(definition.schema, {
    io: "input",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema instanceof z.ZodObject && jsonSchema.required) {
        jsonSchema.required = jsonSchema.required.filter(
          (name) => !zodSchema.shape[name].safeParse(undefined).success,
        );
      }
    },
  });
  const schemaKey = JSON.stringify(jsonSchema);
  let inputSchema = inputSchemas.get(schemaKey);
  if (!inputSchema) {
    inputSchema = fromJsonSchema(jsonSchema as JsonSchemaType);
    inputSchemas.set(schemaKey, inputSchema);
  }
  server.registerTool(
    definition.name,
    {
      description: definition.description,
      inputSchema,
      annotations: {
        readOnlyHint: !definition.write,
        destructiveHint: Boolean(definition.destructive),
        openWorldHint: definition.openWorld ?? false,
      },
    },
    async (args: unknown) => {
      try {
        if (definition.role === "ADMIN" && context.user.role !== "ADMIN") {
          throw new Response(tr("err.mcp.adminRequired"), { status: 403 });
        }
        if (definition.write && context.token.scope !== "READ_WRITE") {
          throw new Response(tr("err.mcp.writeTokenRequired"), {
            status: 403,
          });
        }
        const input = definition.schema.parse(args);
        if (definition.destructive && (!input || Reflect.get(input, "confirm") !== true)) {
          throw new Response(tr("err.mcp.confirmRequired"), {
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
