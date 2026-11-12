import { z } from "zod";
import { msgKey } from "~/i18n";
import {
  EquipmentCategory,
  EquipmentMobility,
  EquipmentStatus,
  MicKind,
} from "~/generated/prisma/enums";

/** Zod schemas for typed Equipment instances. Form values arrive as strings. */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());
const optionalFloat = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.coerce.number().positive(msgKey("places.err.number.positive")).optional(),
);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAC = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const optionalIp = z.preprocess(
  emptyToUndefined,
  z.string().trim().regex(IPV4, msgKey("places.err.equipment.ipInvalid")).optional(),
);
const optionalMac = z.preprocess(
  emptyToUndefined,
  z.string().trim().regex(MAC, msgKey("places.err.equipment.macInvalid")).optional(),
);

// Validated-JSON escape hatch: output stays a string (parsed in the mutation).
const optionalJson = z.preprocess(emptyToUndefined, z.string().optional()).superRefine((s, ctx) => {
  if (typeof s === "string") {
    try {
      JSON.parse(s);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: msgKey("places.err.equipment.jsonInvalid"),
      });
    }
  }
});

export const equipmentCreateSchema = z
  .object({
    category: z.enum(EquipmentCategory),
    modelId: optionalId,
    roomId: optionalId,
    mobility: z.enum(EquipmentMobility).default(EquipmentMobility.FIXED),
    status: z.enum(EquipmentStatus).default(EquipmentStatus.OPERATIONAL),
    name: optionalText,
    assetTag: optionalText,
    serial: optionalText,
    // PC
    hostname: optionalText,
    ipAddress: optionalIp,
    macAddress: optionalMac,
    dellServiceTag: optionalText,
    dellExpressTag: optionalText,
    // microphone
    micKind: z.preprocess(emptyToUndefined, z.enum(MicKind).optional()),
    frequencyMhz: optionalFloat,
    band: optionalText,
    channelLabel: optionalText,
    // projector
    lampType: optionalText,
    lastLampChangeAt: optionalDate,
    // remote / control
    color: optionalText,
    attributes: optionalJson,
  })
  .superRefine((v, ctx) => {
    if (v.mobility === "FIXED" && !v.roomId) {
      ctx.addIssue({
        path: ["roomId"],
        code: z.ZodIssueCode.custom,
        message: msgKey("places.err.equipment.fixedNeedsRoom"),
      });
    }
    if (v.mobility === "POOLED" && v.roomId) {
      ctx.addIssue({
        path: ["roomId"],
        code: z.ZodIssueCode.custom,
        message: msgKey("places.err.equipment.poolNoRoom"),
      });
    }
  });

export const equipmentEditSchema = equipmentCreateSchema;

export type EquipmentCreateInput = z.infer<typeof equipmentCreateSchema> & { kindId?: string };
export type EquipmentEditInput = EquipmentCreateInput;

// ── Equipment CSV bulk import ────────────────────────────────────────────────
// `modell` is matched/auto-created by name; `raum` is matched by slug, room
// number, or name (resolution happens in bulkCreateEquipment).

const CATEGORY_MAP: Record<string, EquipmentCategory> = {
  projektor: "PROJECTOR",
  beamer: "PROJECTOR",
  pc: "PC",
  rechner: "PC",
  mikrofon: "MICROPHONE",
  mic: "MICROPHONE",
  mediensteuerung: "MEDIA_CONTROL",
  steuerung: "MEDIA_CONTROL",
  audio: "AUDIO",
  aufzeichnung: "RECORDER",
  recorder: "RECORDER",
  smartboard: "SMARTBOARD",
  fernbedienung: "REMOTE",
  remote: "REMOTE",
  switcher: "SWITCHER",
  sonstiges: "OTHER",
};
const csvCategory = z.preprocess((v) => {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return CATEGORY_MAP[s] ?? s.toUpperCase();
}, z.enum(EquipmentCategory));

const MOBILITY_MAP: Record<string, EquipmentMobility> = {
  fest: "FIXED",
  "fest verbaut": "FIXED",
  mobil: "POOLED",
  pool: "POOLED",
};
const csvMobility = z.preprocess((v) => {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (!s) return EquipmentMobility.FIXED;
  return MOBILITY_MAP[s] ?? s.toUpperCase();
}, z.enum(EquipmentMobility));

const EQ_STATUS_MAP: Record<string, EquipmentStatus> = {
  betriebsbereit: "OPERATIONAL",
  ok: "OPERATIONAL",
  defekt: "FAULTY",
  wartung: "MAINTENANCE",
  ausgemustert: "RETIRED",
};
const csvEqStatus = z.preprocess((v) => {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (!s) return EquipmentStatus.OPERATIONAL;
  return EQ_STATUS_MAP[s] ?? s.toUpperCase();
}, z.enum(EquipmentStatus));

export const equipmentCsvRowSchema = z
  .object({
    kategorie: csvCategory,
    modell: optionalText,
    raum: optionalText,
    mobilitaet: csvMobility,
    status: csvEqStatus,
    name: optionalText,
    inventarnr: optionalText,
    seriennummer: optionalText,
    hostname: optionalText,
    ip: optionalIp,
    mac: optionalMac,
    frequenz: optionalFloat,
    band: optionalText,
    kanal: optionalText,
  })
  .transform((r) => ({
    category: r.kategorie,
    modelText: r.modell,
    roomText: r.raum,
    mobility: r.mobilitaet,
    status: r.status,
    name: r.name,
    assetTag: r.inventarnr,
    serial: r.seriennummer,
    hostname: r.hostname,
    ipAddress: r.ip,
    macAddress: r.mac,
    frequencyMhz: r.frequenz,
    band: r.band,
    channelLabel: r.kanal,
  }));

export type EquipmentCsvRow = z.infer<typeof equipmentCsvRowSchema>;
