import { z } from "zod";
import { msgKey } from "~/i18n";

/**
 * Zod schemas for the notes domain (`Note`). Same conventions
 * as the tasks schema: form values arrive as strings, optional fields are
 * preprocessed out of empty strings.
 *
 * `body` is a plain string that may be empty — the column is NOT NULL, so
 * "absent" normalises to `""` here and the mutation never has to guess
 * whether the caller meant "clear it" or "didn't send it".
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());

/**
 * A checkbox's truth table, both from form data (`"on"` / absent) and from the
 * domain API (`true`/`false`): absent, `""`, `"false"`, `undefined` all read as
 * `false`.
 */
const booleanField = z.preprocess(
  (v) => v === true || v === "on" || v === "true" || v === "1",
  z.boolean(),
);

/**
 * `tags` from repeated form keys: N inputs arrive as an array, ONE input as a
 * bare string — both are normalised here (trimmed, blanks dropped, deduped) so
 * one blank box can never reject the save.
 */
const tagsField = z.preprocess((v) => {
  const list = v === undefined ? undefined : Array.isArray(v) ? v : [v];
  if (list === undefined) return undefined;
  const cleaned = list
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  return [...new Set(cleaned)];
}, z.array(z.string()).default([]));

const bodyField = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z.string().max(200_000, msgKey("work.err.noteTooLong")),
);

const noteCreateObject = z.object({
  title: z
    .string()
    .trim()
    .min(1, msgKey("work.err.titleRequired"))
    .max(300, msgKey("work.err.titleTooLong")),
  body: bodyField,
  pinned: booleanField,
  tags: tagsField,
  projectId: optionalId,
  locationId: optionalId,
});

export const noteCreateSchema = noteCreateObject;

/** Edit: the same fields — autosave always submits the whole document. */
export const noteEditSchema = noteCreateObject.extend({ id: z.string().min(1) });

/**
 * Editor save: the whole document plus the `version` the editor loaded, which
 * `updateNote` compares against the stored one.
 */
export const noteUpdateSchema = noteCreateObject.extend({
  version: z.coerce.number().int().min(1, msgKey("err.invalidInput")),
});

export type NoteCreateInput = z.infer<typeof noteCreateSchema>;
export type NoteEditInput = z.infer<typeof noteEditSchema>;

/** ── List options ──────────────────────────────────────────────────────────── */

export const noteListOptionsSchema = z.object({
  q: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  tag: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  projectId: optionalId,
  locationId: optionalId,
  archived: z.enum(["exclude", "only", "include"]).optional(),
});

export type NoteListOptions = z.infer<typeof noteListOptionsSchema>;
