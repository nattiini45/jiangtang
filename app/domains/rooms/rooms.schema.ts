import { z } from "zod";
import { customValuesInput } from "~/lib/custom-fields/values.schema";
import { msgKey } from "~/i18n";
import { RoomStatus } from "~/generated/prisma/enums";
import { optionalHttpUrl } from "~/lib/validation.server";
import { roomExpectationsInput } from "./room-types.schema";

/**
 * Zod schemas for the rooms domain. Form values arrive as strings / string[].
 * (The clone + CSV schemas are appended at their steps; this file holds the
 * Campus → Building location schemas and the room create/edit schema.)
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

// ── Campus ───────────────────────────────────────────────────────────────────
export const campusCreateSchema = z.object({
  name: z.string().trim().min(1, msgKey("places.err.name.required")),
});
export const campusEditSchema = campusCreateSchema.extend({
  id: z.string().min(1),
});

// ── Building ─────────────────────────────────────────────────────────────────
export const buildingCreateSchema = z.object({
  campusId: z.string().min(1, msgKey("places.err.campus.required")),
  name: z.string().trim().min(1, msgKey("places.err.name.required")),
  code: optionalText,
});
export const buildingEditSchema = buildingCreateSchema.extend({
  id: z.string().min(1),
});

export type CampusCreateInput = z.infer<typeof campusCreateSchema>;
export type CampusEditInput = z.infer<typeof campusEditSchema>;
export type BuildingCreateInput = z.infer<typeof buildingCreateSchema>;
export type BuildingEditInput = z.infer<typeof buildingEditSchema>;

// ── Room ─────────────────────────────────────────────────────────────────────

const checkbox = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = optionalHttpUrl;
const optionalInt = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.coerce.number().int().positive(msgKey("places.err.number.positive")).optional(),
);
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());
const stringArray = z.preprocess((v) => {
  const arr = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
}, z.array(z.string()));

export const roomCreateSchema = z
  .object({
    customValues: customValuesInput,
    roomTypeId: z
      .string()
      .transform((value) => (value && value !== "none" ? value : null))
      .nullable()
      .optional(),
    expectations: roomExpectationsInput,
    name: z.string().trim().min(1, msgKey("places.err.room.nameRequired")),
    roomNumber: optionalText,
    campusId: optionalId,
    newCampusName: optionalText,
    buildingId: optionalId,
    newBuildingName: optionalText,
    capacity: optionalInt,
    owner: optionalText,
    status: z.enum(RoomStatus).default(RoomStatus.ALL_GOOD),
    hasProjector: checkbox,
    hasMicrophony: checkbox,
    hasBlackboard: checkbox,
    hasWebConference: checkbox,
    hasAutoRecording: checkbox,
    mediaKeyRequired: checkbox,
    videoInputs: stringArray,
    audioOutputs: stringArray,
    bookingUrl: optionalUrl,
    manualUrl: optionalUrl,
    virtualTourUrl: optionalUrl,
    tipsNotes: optionalText,
    knownIssues: optionalText,
    lastCheckedAt: optionalDate,
    renewalStatus: optionalText,
    renewalFrom: optionalDate,
    renewalTo: optionalDate,
  })
  // Mirrors the DB CHECK room_renewal_order (20261023000200_booking_constraints):
  // show a 422 field error instead of a raw 500 when the window is inverted.
  // Keep both in lockstep.
  .refine((r) => !(r.renewalFrom && r.renewalTo) || r.renewalFrom <= r.renewalTo, {
    message: msgKey("places.err.room.renewalOrder"),
    path: ["renewalTo"],
  });

export const roomEditSchema = roomCreateSchema;

export type RoomCreateInput = z.infer<typeof roomCreateSchema>;
export type RoomEditInput = z.infer<typeof roomEditSchema>;

// ── Room clone ───────────────────────────────────────────────────────────────
// "Duplicate this hall's setup": a new room + the source's technical setup. Links
// (booking/manual/360) and unit identifiers (serial/IP/MAC/frequency) are room/
// unit-specific and never cloned.
export const roomCloneSchema = z.object({
  name: z.string().trim().min(1, msgKey("places.err.room.nameRequired")),
  roomNumber: optionalText,
  campusId: optionalId,
  newCampusName: optionalText,
  buildingId: optionalId,
  newBuildingName: optionalText,
  copyFeatures: checkbox,
  copyCapabilities: checkbox,
  copyTips: checkbox,
  copyEquipment: checkbox,
});

export type RoomCloneInput = z.infer<typeof roomCloneSchema>;

// ── Room CSV bulk import ─────────────────────────────────────────────────────
// Lenient row schema for onboarding many rooms. Booleans accept ja/yes/1/x; status
// accepts German labels or enum names; list columns split on ; or |. The schema
// transforms German headers into the normalized shape bulkCreateRooms consumes.

const csvBool = z.preprocess((v) => {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return ["ja", "yes", "y", "1", "true", "wahr", "x"].includes(s);
}, z.boolean());

const ROOM_STATUS_MAP: Record<string, RoomStatus> = {
  "in ordnung": "ALL_GOOD",
  ok: "ALL_GOOD",
  provisorium: "PROVISIONAL",
  "wartung nötig": "MAINTENANCE_NEEDED",
  "wartung noetig": "MAINTENANCE_NEEDED",
  technikdefekt: "TECH_DEFECT",
  defekt: "TECH_DEFECT",
  "außer betrieb": "OUT_OF_SERVICE",
  "ausser betrieb": "OUT_OF_SERVICE",
};

const csvStatus = z.preprocess((v) => {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (!s) return RoomStatus.ALL_GOOD;
  return ROOM_STATUS_MAP[s] ?? s.toUpperCase();
}, z.enum(RoomStatus));

const csvList = z.preprocess((v) => {
  const s = String(v ?? "").trim();
  return s
    ? s
        .split(/[;|]/)
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}, z.array(z.string()));

export const roomCsvRowSchema = z
  .object({
    name: z.string().trim().min(1, msgKey("places.err.room.csvNameMissing")),
    raumnummer: optionalText,
    campus: optionalText,
    gebaeude: optionalText,
    plaetze: optionalInt,
    besitzer: optionalText,
    status: csvStatus,
    projektor: csvBool,
    mikrofonie: csvBool,
    tafel: csvBool,
    webkonferenz: csvBool,
    aufzeichnung: csvBool,
    medienschluessel: csvBool,
    videoeingaenge: csvList,
    tonausgaenge: csvList,
    knownIssues: optionalText,
    lastCheckedAt: z.preprocess(
      emptyToUndefined,
      z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value))
        .optional(),
    ),
  })
  .transform((r) => ({
    name: r.name,
    roomNumber: r.raumnummer,
    campusName: r.campus,
    buildingName: r.gebaeude,
    capacity: r.plaetze,
    owner: r.besitzer,
    status: r.status,
    hasProjector: r.projektor,
    hasMicrophony: r.mikrofonie,
    hasBlackboard: r.tafel,
    hasWebConference: r.webkonferenz,
    hasAutoRecording: r.aufzeichnung,
    mediaKeyRequired: r.medienschluessel,
    videoInputs: r.videoeingaenge,
    audioOutputs: r.tonausgaenge,
    knownIssues: r.knownIssues,
    lastCheckedAt: r.lastCheckedAt,
  }));

export const roomBulkRowSchema = z.intersection(
  roomCsvRowSchema,
  z.object({ customValues: customValuesInput }),
);

export type RoomCsvRow = Omit<z.infer<typeof roomCsvRowSchema>, "knownIssues" | "lastCheckedAt"> & {
  customValues?: Record<string, unknown>;
  knownIssues?: string;
  lastCheckedAt?: Date;
};
