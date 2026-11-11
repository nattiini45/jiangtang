import { z } from "zod";
import { msgKey } from "~/i18n";

export const PORT_CONNECTORS = [
  "HDMI",
  "DISPLAYPORT",
  "USB_C",
  "USB_A",
  "USB_B",
  "VGA",
  "DVI",
  "SDI_BNC",
  "RJ45",
  "HDBASET",
  "FIBER_LC",
  "XLR",
  "JACK_6_3",
  "JACK_3_5",
  "RCA",
  "SPEAKON",
  "TERMINAL_BLOCK",
  "DSUB9",
  "IR",
  "IEC_POWER",
  "OTHER",
] as const;
export const PORT_DIRECTIONS = ["INPUT", "OUTPUT", "BIDIRECTIONAL"] as const;
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
  position: z.coerce.number().int().min(0).max(10000),
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
