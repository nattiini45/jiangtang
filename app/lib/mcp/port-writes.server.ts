import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { setEquipmentModelPorts } from "~/domains/catalog/catalog.ports.mutations.server";
import { mutateEquipmentPort } from "~/domains/inventory/inventory.ports.mutations.server";
import {
  connectEquipmentPorts,
  disconnectEquipmentPorts,
} from "~/domains/inventory/inventory.connections.mutations.server";
import {
  equipmentPortSchema,
  modelPortsSchema,
  connectPortsSchema,
} from "~/domains/inventory/inventory.ports.schema";
import { registerTool } from "./tools.server";
import { mcpActor, type McpContext } from "./types.server";

const id = z.string().trim().min(1);
export function registerPortWrites(server: McpServer, context: McpContext) {
  registerTool(
    server,
    context,
    {
      name: "connect_equipment_ports",
      write: true,
      description:
        "Connect a free device port to a free port of another device, or create the other port atomically. Supply targetPortId OR newPort, plus optional cable/route note. Direction and signal are descriptive, not compatibility rules.",
      schema: connectPortsSchema,
    },
    (input, ctx) => connectEquipmentPorts(mcpActor(ctx), input),
  );
  registerTool(
    server,
    context,
    {
      name: "disconnect_equipment_ports",
      write: true,
      destructive: true,
      description:
        "Disconnect a connection visible on this device, retaining both ports. Requires confirm=true. Get the connectionId from get_equipment.",
      schema: z.object({ equipmentId: id, connectionId: id, confirm: z.literal(true) }),
    },
    (input, ctx) => disconnectEquipmentPorts(mcpActor(ctx), input.equipmentId, input.connectionId),
  );
  registerTool(
    server,
    context,
    {
      name: "set_equipment_model_ports",
      write: true,
      description:
        "Replace and reorder a model's port templates. Existing devices are unchanged. An empty list removes all templates.",
      schema: z.object({ modelId: id, ports: modelPortsSchema }),
    },
    (input, ctx) => setEquipmentModelPorts(mcpActor(ctx), input.modelId, input.ports),
  );
  for (const action of ["add", "update", "remove"] as const) {
    registerTool(
      server,
      context,
      {
        name: `${action}_equipment_port`,
        write: true,
        description: `${action} a device port. Updates replace all editable fields; position starts at zero. Removal requires confirm=true.`,
        destructive: action === "remove",
        schema: z.object({
          equipmentId: id,
          portId: action === "add" ? z.never().optional() : id,
          input: action === "remove" ? z.never().optional() : equipmentPortSchema,
          confirm: action === "remove" ? z.literal(true) : z.never().optional(),
        }),
      },
      (input, ctx) =>
        mutateEquipmentPort(mcpActor(ctx), input.equipmentId, action, input.input, input.portId),
    );
  }
  registerTool(
    server,
    context,
    {
      name: "inherit_equipment_model_ports",
      write: true,
      description:
        "Add missing ports from the device's current model, matched by label, without changing its existing ports.",
      schema: z.object({ equipmentId: id }),
    },
    (input, ctx) => mutateEquipmentPort(mcpActor(ctx), input.equipmentId, "inherit"),
  );
}
