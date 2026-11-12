import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { msgKey } from "~/i18n";
import { withoutEquipmentKind } from "./tools.server";
import {
  createCampus,
  updateCampus,
  createBuilding,
  updateBuilding,
  createRoom,
  updateRoom,
  retireRoom,
  cloneRoom,
  bulkCreateRooms,
} from "~/domains/rooms/rooms.mutations.server";
import {
  campusCreateSchema,
  campusEditSchema,
  buildingCreateSchema,
  buildingEditSchema,
  roomCreateSchema,
  roomEditSchema,
  roomCloneSchema,
  roomCsvRowSchema,
} from "~/domains/rooms/rooms.schema";
import {
  createLocation,
  updateLocation,
  moveLocation,
  deleteLocation,
} from "~/domains/locations/locations.mutations.server";
import {
  locationCreateSchema,
  locationEditSchema,
  locationMoveSchema,
} from "~/domains/locations/locations.schema";
import { createModel, updateModel } from "~/domains/catalog/catalog.mutations.server";
import { modelCreateSchema, modelEditSchema } from "~/domains/catalog/catalog.schema";
import {
  createEquipment,
  updateEquipment,
  retireEquipment,
  setSubstitution,
  bulkCreateEquipment,
} from "~/domains/inventory/inventory.mutations.server";
import {
  equipmentCreateSchema,
  equipmentEditSchema,
  equipmentBulkRowSchema,
} from "~/domains/inventory/inventory.schema";
import {
  createStockItem,
  updateStockItem,
  deleteStockItem,
  linkStockItemToEquipment,
  unlinkStockItemFromEquipment,
} from "~/domains/inventory/inventory.stock.mutations.server";
import { stockCreateSchema, stockEditSchema } from "~/domains/inventory/inventory.stock.schema";
import {
  createVendor,
  updateVendor,
  deleteVendor,
} from "~/domains/vendors/vendors.mutations.server";
import { vendorCreateSchema, vendorEditSchema } from "~/domains/vendors/vendors.schema";
import { emitChange } from "~/lib/realtime/emit.server";
import type { ChangeOp, EntityType } from "~/lib/realtime/events";
import { registerTool } from "./tools.server";
import { mcpActor, type McpContext } from "./types.server";
import { withCustomValues } from "~/lib/custom-fields/values.server";

const id = z.string().trim().min(1);
const byId = z.object({ id });
const confirmedId = byId.extend({ confirm: z.literal(true) });
const instant = z.iso.datetime({ offset: true });
const roomInstants = {
  lastCheckedAt: instant
    .optional()
    .transform((value) => roomCreateSchema.shape.lastCheckedAt.parse(value)),
  renewalFrom: instant
    .optional()
    .transform((value) => roomCreateSchema.shape.renewalFrom.parse(value)),
  renewalTo: instant.optional().transform((value) => roomCreateSchema.shape.renewalTo.parse(value)),
};
const equipmentInstants = {
  lastLampChangeAt: instant
    .optional()
    .transform((value) => equipmentCreateSchema.shape.lastLampChangeAt.parse(value)),
};
const stockInstants = {
  purchasedAt: instant
    .nullable()
    .optional()
    .transform((value) => stockCreateSchema.shape.purchasedAt.parse(value)),
  warrantyExpiresAt: instant
    .nullable()
    .optional()
    .transform((value) => stockCreateSchema.shape.warrantyExpiresAt.parse(value)),
};

export function registerPlaceWrites(server: McpServer, context: McpContext): void {
  function write<S extends z.ZodType>(
    definition: {
      name: string;
      description: string;
      schema: S;
      role?: "ADMIN";
      destructive?: true;
      entityType: EntityType;
      op: ChangeOp;
    },
    handler: (input: z.output<S>, ctx: McpContext) => Promise<{ id: string } | { created: number }>,
  ) {
    registerTool(server, context, { ...definition, write: true }, async (input, ctx) => {
      let result = await handler(input, ctx);
      if (
        (definition.entityType === "room" || definition.entityType === "equipment") &&
        "id" in result &&
        "customValues" in result
      )
        result = (
          await withCustomValues(
            definition.entityType === "room" ? "ROOM" : "EQUIPMENT",
            [result],
            true,
          )
        )[0];
      await emitChange({
        entityType: definition.entityType,
        id: "id" in result ? result.id : "bulk",
        op: definition.op,
      });
      return definition.entityType === "equipment" || definition.entityType === "equipmentModel"
        ? withoutEquipmentKind(result)
        : result;
    });
  }

  write(
    {
      name: "create_campus",
      description: "Create a campus.",
      schema: campusCreateSchema,
      entityType: "campus",
      op: "created",
    },
    (input, ctx) => createCampus(mcpActor(ctx), input),
  );
  write(
    {
      name: "update_campus",
      description: "Rename a campus by ID.",
      schema: campusEditSchema,
      entityType: "campus",
      op: "updated",
    },
    (input, ctx) => updateCampus(mcpActor(ctx), input.id, input),
  );
  write(
    {
      name: "create_building",
      description: "Create a building in a campus.",
      schema: buildingCreateSchema,
      entityType: "building",
      op: "created",
    },
    (input, ctx) => createBuilding(mcpActor(ctx), input),
  );
  write(
    {
      name: "update_building",
      description: "Replace a building's name, code and campus by ID.",
      schema: buildingEditSchema,
      entityType: "building",
      op: "updated",
    },
    (input, ctx) => updateBuilding(mcpActor(ctx), input.id, input),
  );
  write(
    {
      name: "create_room",
      description:
        "Create a bookable room with optional knownIssues and lastCheckedAt. Check and renewal instants require an ISO timestamp with an offset.",
      schema: roomCreateSchema.safeExtend(roomInstants),
      entityType: "room",
      op: "created",
    },
    (input, ctx) => createRoom(mcpActor(ctx), input),
  );
  write(
    {
      name: "update_room",
      description:
        "Replace every built-in editable room field by ID, not slug. Omitted optional built-in fields are cleared. customValues is the exception: omitted leaves values untouched; supplied keys merge, null clears a key. Check and renewal instants require an ISO timestamp with an offset.",
      schema: z.object({ id, input: roomEditSchema.safeExtend(roomInstants) }),
      entityType: "room",
      op: "updated",
    },
    (input, ctx) => updateRoom(mcpActor(ctx), input.id, input.input),
  );
  write(
    {
      name: "retire_room",
      description:
        "Take a room out of service without deleting its booking history. Requires confirm=true.",
      schema: confirmedId,
      destructive: true,
      entityType: "room",
      op: "updated",
    },
    (input, ctx) => retireRoom(mcpActor(ctx), input.id),
  );
  write(
    {
      name: "clone_room",
      description:
        "Clone a room by source slug, copying only the explicitly selected setup and equipment fields.",
      schema: z.object({ sourceSlug: id, input: roomCloneSchema }),
      entityType: "room",
      op: "created",
    },
    (input, ctx) => cloneRoom(mcpActor(ctx), input.sourceSlug, input.input),
  );
  write(
    {
      name: "bulk_create_rooms",
      description:
        "Atomically import 1–500 rooms using the existing CSV row fields (including German column names). Returns the count and created room IDs, names and slugs. ADMIN only.",
      schema: z.object({ rows: z.array(roomCsvRowSchema).min(1).max(500) }),
      role: "ADMIN",
      entityType: "room",
      op: "created",
    },
    (input, ctx) => bulkCreateRooms(mcpActor(ctx), input.rows),
  );
  write(
    {
      name: "create_location",
      description:
        "Create a location in the independent storage/place tree, optionally under a parent.",
      schema: locationCreateSchema,
      entityType: "location",
      op: "created",
    },
    (input, ctx) => createLocation(mcpActor(ctx), input),
  );
  write(
    {
      name: "update_location",
      description:
        "Replace a location's editable fields by ID. Use move_location to change its parent.",
      schema: locationEditSchema,
      entityType: "location",
      op: "updated",
    },
    (input, ctx) => updateLocation(mcpActor(ctx), input.id, input),
  );
  write(
    {
      name: "move_location",
      description:
        "Reparent a location and its subtree. A null parentId promotes it to a root; cycles are rejected.",
      schema: locationMoveSchema,
      entityType: "location",
      op: "updated",
    },
    (input, ctx) => moveLocation(mcpActor(ctx), input.id, input.parentId),
  );
  write(
    {
      name: "delete_location",
      description:
        "Delete a childless location, detaching stock, tasks, notes and vendors. Requires confirm=true.",
      schema: confirmedId,
      destructive: true,
      entityType: "location",
      op: "deleted",
    },
    (input, ctx) => deleteLocation(mcpActor(ctx), input.id),
  );
  write(
    {
      name: "create_equipment_model",
      description:
        "Create an equipment catalog model with kindId, or the legacy category alias. kindId takes precedence and determines category.",
      schema: modelCreateSchema,
      entityType: "equipmentModel",
      op: "created",
    },
    (input, ctx) => createModel(mcpActor(ctx), input),
  );
  write(
    {
      name: "update_equipment_model",
      description:
        "Replace a catalog model's editable fields by ID. Use kindId or the legacy category alias; a matching category preserves the current kind. Catalog models cannot be deleted.",
      schema: z.object({ id, input: modelEditSchema }),
      entityType: "equipmentModel",
      op: "updated",
    },
    (input, ctx) => updateModel(mcpActor(ctx), input.id, input.input),
  );
  write(
    {
      name: "create_equipment",
      description:
        "Create an equipment instance with kindId, or the legacy category alias. kindId takes precedence and determines category. FIXED requires roomId; POOLED forbids roomId. Lamp-change instants require an ISO timestamp with an offset.",
      schema: equipmentCreateSchema.safeExtend(equipmentInstants),
      entityType: "equipment",
      op: "created",
    },
    (input, ctx) => createEquipment(mcpActor(ctx), input),
  );
  write(
    {
      name: "update_equipment",
      description:
        "Replace every built-in editable device field by ID. Use kindId or the legacy category alias; a matching category preserves the current kind. Other omitted optional built-in fields are cleared. customValues is the exception: omitted leaves values untouched; supplied keys merge, null clears a key. Lamp-change instants require an ISO timestamp with an offset. Use retire_equipment with confirm=true to retire a device and clear substitution links.",
      schema: z.object({
        id,
        input: equipmentEditSchema
          .safeExtend(equipmentInstants)
          .refine((input) => input.status !== "RETIRED", {
            path: ["status"],
            message: msgKey("err.mcp.useRetireEquipment"),
          }),
      }),
      entityType: "equipment",
      op: "updated",
    },
    (input, ctx) => updateEquipment(mcpActor(ctx), input.id, input.input),
  );
  write(
    {
      name: "retire_equipment",
      description:
        "Retire equipment without deleting allocation history, clearing substitution links. Requires confirm=true.",
      schema: confirmedId,
      destructive: true,
      entityType: "equipment",
      op: "updated",
    },
    (input, ctx) => retireEquipment(mcpActor(ctx), input.id),
  );
  write(
    {
      name: "set_equipment_substitution",
      description:
        "Set a spare's faulty-equipment target, or pass faultyId=null to clear it. Requires confirm=true.",
      schema: z.object({ spareId: id, faultyId: id.nullable(), confirm: z.literal(true) }),
      destructive: true,
      entityType: "equipment",
      op: "updated",
    },
    (input, ctx) => setSubstitution(mcpActor(ctx), input),
  );
  write(
    {
      name: "bulk_create_equipment",
      description:
        "Atomically import 1–500 equipment instances using the existing CSV row fields (including German column names), plus kindId. Each row requires kindId or kategorie; kindId takes precedence. Returns the count and created equipment IDs, names, categories and asset tags. ADMIN only.",
      schema: z.object({ rows: z.array(equipmentBulkRowSchema).min(1).max(500) }),
      role: "ADMIN",
      entityType: "equipment",
      op: "created",
    },
    (input, ctx) => bulkCreateEquipment(mcpActor(ctx), input.rows),
  );
  write(
    {
      name: "create_stock_item",
      description:
        "Create tracked stock, optionally linked to equipment, a vendor and a location. Purchase/warranty instants require an ISO timestamp with an offset or null.",
      schema: stockCreateSchema.extend(stockInstants),
      entityType: "inventory-item",
      op: "created",
    },
    (input, ctx) => createStockItem(mcpActor(ctx), input),
  );
  write(
    {
      name: "update_stock_item",
      description:
        "Replace a stock item's editable fields by ID, preserving its equipment link. Use link_stock_item_to_equipment or the confirmed unlink_stock_item_from_equipment to change that link. Other omitted optional fields are cleared; purchase/warranty instants require an ISO timestamp with an offset or null.",
      schema: stockEditSchema.omit({ equipmentId: true }).extend(stockInstants),
      entityType: "inventory-item",
      op: "updated",
    },
    (input, ctx) => updateStockItem(mcpActor(ctx), input.id, input),
  );
  write(
    {
      name: "delete_stock_item",
      description: "Delete a stock item after unlinking any equipment. Requires confirm=true.",
      schema: confirmedId,
      destructive: true,
      entityType: "inventory-item",
      op: "deleted",
    },
    (input, ctx) => deleteStockItem(mcpActor(ctx), input.id),
  );
  write(
    {
      name: "link_stock_item_to_equipment",
      description:
        "Link an unlinked stock item to an equipment instance; one stock item per equipment instance.",
      schema: z.object({ id, equipmentId: id }),
      entityType: "inventory-item",
      op: "updated",
    },
    (input, ctx) => linkStockItemToEquipment(mcpActor(ctx), input.id, input.equipmentId),
  );
  write(
    {
      name: "unlink_stock_item_from_equipment",
      description:
        "Remove a stock item's equipment link, keeping both records. Requires confirm=true.",
      schema: confirmedId,
      destructive: true,
      entityType: "inventory-item",
      op: "updated",
    },
    (input, ctx) => unlinkStockItemFromEquipment(mcpActor(ctx), input.id),
  );
  write(
    {
      name: "create_vendor",
      description:
        "Create a vendor with optional contact details and location. Available to every signed-in member.",
      schema: vendorCreateSchema,
      entityType: "vendor",
      op: "created",
    },
    (input, ctx) => createVendor(mcpActor(ctx), input),
  );
  write(
    {
      name: "update_vendor",
      description:
        "Replace a vendor's editable fields by ID; omitted optional fields are cleared. Available to every signed-in member.",
      schema: vendorEditSchema,
      entityType: "vendor",
      op: "updated",
    },
    (input, ctx) => updateVendor(mcpActor(ctx), input.id, input),
  );
  write(
    {
      name: "delete_vendor",
      description:
        "Delete a vendor, detaching its stock items without deleting them. Requires confirm=true. Available to every signed-in member.",
      schema: confirmedId,
      destructive: true,
      entityType: "vendor",
      op: "deleted",
    },
    (input, ctx) => deleteVendor(mcpActor(ctx), input.id),
  );
}
