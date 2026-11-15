import { z } from "zod";
import { msgKey } from "~/i18n";

export const PORT_CONNECTORS = [
  "HDMI",
  "DISPLAYPORT",
  "USB_C",
  "USB_A",
  "USB_B",
  "USB_MINI_B",
  "USB_MICRO_B",
  "VGA",
  "DVI",
  "SDI_BNC",
  "BNC",
  "S_VIDEO",
  "RJ45",
  "RJ12",
  "HDBASET",
  "FIBER_LC",
  "FIBER_SC",
  "SFP",
  "XLR",
  "JACK_6_3",
  "JACK_3_5",
  "RCA",
  "SPEAKON",
  "TERMINAL_BLOCK",
  "DSUB9",
  "IR",
  "IEC_POWER",
  "DC_POWER",
  "POWERCON",
  "OTHER",
] as const;
export const PORT_DIRECTIONS = ["INPUT", "OUTPUT", "BIDIRECTIONAL"] as const;
export const MAX_PORT_POSITION = 10000;
export const PORT_SIGNALS = [
  "VIDEO",
  "AUDIO",
  "AUDIO_VIDEO",
  "CONTROL",
  "NETWORK",
  "USB",
  "POWER",
  "OTHER",
] as const;

export const modelPortSchema = z.object({
  label: z.string().trim().min(1, msgKey("ports.required")).max(120),
  connector: z.enum(PORT_CONNECTORS),
  direction: z.enum(PORT_DIRECTIONS),
  signal: z.enum(PORT_SIGNALS),
});
export const equipmentPortSchema = modelPortSchema.extend({
  position: z.coerce.number().int().min(0).max(MAX_PORT_POSITION, msgKey("ports.positionFull")),
  note: z.string().trim().max(2000).nullable().optional(),
});
export const modelPortsSchema = z
  .array(modelPortSchema)
  .max(200)
  .superRefine((ports, ctx) => {
    if (new Set(ports.map((port) => port.label)).size !== ports.length) {
      ctx.addIssue({ code: "custom", message: msgKey("ports.duplicate") });
    }
  });
export type PortInput = z.output<typeof equipmentPortSchema>;

const portId = z.string().trim().min(1);
export const connectPortsSchema = z
  .object({
    equipmentId: portId,
    portId,
    targetEquipmentId: portId,
    targetPortId: portId.optional(),
    newPort: equipmentPortSchema.optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (Boolean(input.targetPortId) === Boolean(input.newPort))
      ctx.addIssue({ code: "custom", message: msgKey("ports.chooseTarget") });
  });
