import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createFieldSchema,
  updateFieldSchema,
  fieldOptionsSchema,
  fieldScope,
} from "~/lib/custom-fields/definitions.schema";
import {
  createCustomField,
  updateCustomField,
  updateFieldOptions,
  deleteCustomField,
  getRecordSchema,
} from "~/lib/custom-fields/definitions.server";
import { registerTool } from "./tools.server";
import { mcpActor, type McpContext } from "./types.server";

export function registerFieldTools(server: McpServer, context: McpContext) {
  registerTool(
    server,
    context,
    {
      name: "get_record_schema",
      description:
        "Read active custom fields and their options for ROOM or EQUIPMENT. Supply kindId for kind-specific device fields. Retired options remain marked archivedAt and cannot be selected.",
      schema: z.object({ scope: fieldScope, kindId: z.string().optional() }),
    },
    ({ scope, kindId }) => getRecordSchema(scope, kindId),
  );
  registerTool(
    server,
    context,
    {
      name: "create_custom_field",
      description:
        "Define a custom field. No kindIds means all records in the scope. Keys and types are immutable. Admin write token required.",
      schema: createFieldSchema,
      role: "ADMIN",
      write: true,
    },
    (input, ctx) => createCustomField(mcpActor(ctx), input),
  );
  registerTool(
    server,
    context,
    {
      name: "update_custom_field",
      description:
        "Patch a field definition, including kindIds, order and archived (true to archive, false to restore). Omitted properties are unchanged. Admin write token required.",
      schema: updateFieldSchema,
      role: "ADMIN",
      write: true,
    },
    (input, ctx) => updateCustomField(mcpActor(ctx), input),
  );
  registerTool(
    server,
    context,
    {
      name: "update_field_options",
      description:
        "Atomically add, rename, reorder, retire, restore or delete choice options. No merge. Admin write token required.",
      schema: fieldOptionsSchema,
      role: "ADMIN",
      write: true,
    },
    (input, ctx) => updateFieldOptions(mcpActor(ctx), input),
  );
  registerTool(
    server,
    context,
    {
      name: "delete_custom_field",
      description:
        "Delete an unused custom field and its options. Requires confirm=true and an admin write token.",
      schema: z.object({ id: z.string().min(1), confirm: z.literal(true) }),
      role: "ADMIN",
      write: true,
      destructive: true,
    },
    ({ id }, ctx) => deleteCustomField(mcpActor(ctx), id),
  );
}
