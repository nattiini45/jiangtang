import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listModelCatalog } from "~/lib/catalog/catalog.server";
import { linkCatalogModel, unlinkCatalogModel } from "~/domains/catalog/catalog.library.server";
import { registerTool } from "./tools.server";
import { mcpActor, type McpContext } from "./types.server";

export function registerCatalogTools(server: McpServer, context: McpContext) {
  registerTool(
    server,
    context,
    {
      name: "list_model_catalog",
      description:
        "Search the shipped model catalog by manufacturer, name, alias or part number; kind is a library kind key. Returns facts, ports and manufacturer sources, not installation models.",
      schema: z.object({ query: z.string().max(200).optional(), kind: z.string().optional() }),
    },
    listModelCatalog,
  );
  registerTool(
    server,
    context,
    {
      name: "link_catalog_model",
      description:
        "Link an installation model to a catalog record, filling only empty values, manual and ports. Without modelId, reuse an exact manufacturer/name/kind match or create the model. Devices without ports receive its ports.",
      schema: z.object({ catalogKey: z.string().min(1), modelId: z.string().min(1).optional() }),
      write: true,
    },
    ({ catalogKey, modelId }, ctx) => linkCatalogModel(mcpActor(ctx), catalogKey, modelId),
  );
  registerTool(
    server,
    context,
    {
      name: "unlink_catalog_model",
      description:
        "Unlink a model, removing values, manual and model ports only while they still equal what the catalog wrote. House edits and device ports stay. Admin write token required.",
      schema: z.object({ modelId: z.string().min(1) }),
      write: true,
      role: "ADMIN",
    },
    ({ modelId }, ctx) => unlinkCatalogModel(mcpActor(ctx), modelId),
  );
}
