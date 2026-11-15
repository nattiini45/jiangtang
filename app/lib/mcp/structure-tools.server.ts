import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createDeviceKind,
  updateDeviceKind,
  createFunctionGroup,
  updateFunctionGroup,
} from "~/lib/equipment-kinds/structure.server";
import {
  groupCreateSchema,
  groupUpdateSchema,
  kindCreateSchema,
  kindUpdateSchema,
} from "~/lib/equipment-kinds/structure.schema";
import { registerTool } from "./tools.server";
import { mcpActor, type McpContext } from "./types.server";
import {
  installLibraryKinds,
  libraryInstallSchema,
  libraryQuerySchema,
  listKindLibrary,
} from "~/lib/equipment-kinds/library.server";

export function registerStructureTools(server: McpServer, context: McpContext) {
  registerTool(
    server,
    context,
    {
      name: "list_kind_library",
      description:
        "List the bilingual device-kind library, optionally filtered by institutionType. Includes present/archived/name-taken status and remaining capacity. Admin only; installs nothing.",
      schema: libraryQuerySchema,
      role: "ADMIN",
    },
    ({ institutionType }) => listKindLibrary(institutionType),
  );
  registerTool(
    server,
    context,
    {
      name: "install_library_kinds",
      description:
        "Install exactly the selected library keys, atomically, in DEFAULT_LOCALE. Creates missing groups. Refuses existing, archived, taken or unknown entries without installing anything. Admin only.",
      schema: libraryInstallSchema,
      role: "ADMIN",
      write: true,
    },
    (input, ctx) => installLibraryKinds(mcpActor(ctx), input),
  );
  const id = z.string().min(1);
  registerTool(
    server,
    context,
    {
      name: "create_function_group",
      description: "Create an active function group (maximum 30). Admin only.",
      schema: groupCreateSchema,
      role: "ADMIN",
      write: true,
    },
    (input, ctx) => createFunctionGroup(mcpActor(ctx), input),
  );
  registerTool(
    server,
    context,
    {
      name: "update_function_group",
      description:
        "Rename, reorder, archive or restore a function group. Archiving requires no active kinds. Admin only.",
      schema: groupUpdateSchema.extend({ id }),
      role: "ADMIN",
      write: true,
    },
    ({ id, ...input }, ctx) => updateFunctionGroup(mcpActor(ctx), id, input),
  );
  registerTool(
    server,
    context,
    {
      name: "create_device_kind",
      description:
        "Create a device kind in an active group (maximum 80). Frequency tracking is not configurable. Admin only.",
      schema: kindCreateSchema,
      role: "ADMIN",
      write: true,
    },
    (input, ctx) => createDeviceKind(mcpActor(ctx), input),
  );
  registerTool(
    server,
    context,
    {
      name: "update_device_kind",
      description:
        "Rename, regroup, reorder, archive or restore a kind. To archive a used kind, provide moveDevicesTo; devices and models move atomically. Legacy category kinds cannot be archived. Admin only.",
      schema: kindUpdateSchema.extend({ id }),
      role: "ADMIN",
      write: true,
    },
    ({ id, ...input }, ctx) => updateDeviceKind(mcpActor(ctx), id, input),
  );
}
