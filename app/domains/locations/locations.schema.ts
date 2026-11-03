import { z } from "zod";
import { msgKey } from "~/i18n";
import { LocationKind } from "~/generated/prisma/enums";

/**
 * Zod schemas for the locations domain (`Location` — the multi-type
 * location spine). Form values arrive as strings, so optional text is preprocessed
 * out of empty strings exactly as the rooms domain does.
 *
 * `kind` is validated with `z.enum(LocationKind)` rather than a hand-written
 * `z.enum([...])`: the value set is the generated enum, so the schema cannot drift
 * away from the database's 8 values (the enum spells them out).
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());

/** ── Create / edit ─────────────────────────────────────────────────────────── */

export const locationCreateSchema = z.object({
  name: z.string().trim().min(1, msgKey("places.err.name.required")),
  kind: z.enum(LocationKind),
  code: optionalText,
  address: optionalText,
  description: optionalText,
  /** `parentId` is a CREATE-time field only — a reparent goes through `moveLocation`. */
  parentId: optionalId,
});

export const locationEditSchema = locationCreateSchema
  .omit({ parentId: true })
  .extend({ id: z.string().min(1) });

export type LocationCreateInput = z.infer<typeof locationCreateSchema>;
export type LocationEditInput = z.infer<typeof locationEditSchema>;

/** ── Tree query options ────────────────────────────────────────────────────── */

export const locationTreeOptionsSchema = z.object({
  /** Omit (or pass null) for the whole forest — every root and its descendants. */
  parentId: optionalId,
  kind: z.preprocess(emptyToUndefined, z.enum(LocationKind).optional()),
});

export type LocationTreeOptions = z.infer<typeof locationTreeOptionsSchema>;

/** ── Move ──────────────────────────────────────────────────────────────────── */

export const locationMoveSchema = z.object({
  id: z.string().min(1),
  /** `null` moves the node to the root of the forest. */
  parentId: z.preprocess((v) => (v === "" || v === null ? null : v), z.string().min(1).nullable()),
});

export type LocationMoveInput = z.infer<typeof locationMoveSchema>;
