import { z } from "zod";
import { msgKey } from "~/i18n";
import { ProjectStatus } from "~/generated/prisma/enums";

/**
 * Zod schemas for the projects domain (`Project` — the container a
 * department's AV request lives in). Same conventions as the locations and
 * stock schemas: form values arrive as strings, so optional text is
 * preprocessed out of empty strings.
 *
 * **`status` is create-time-only here.** On edit it is deliberately absent: a
 * status change goes through `setProjectStatus` so every transition is audited
 * as `ProjectStatusChanged {from,to}` rather than silently folded into an
 * `updateProject` diff.
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());

/**
 * An optional date: `Date` (server path) or a parsable string (form path);
 * `""`/`null` mean "cleared" and pass through as `null` so the mutation can
 * distinguish "cleared" from "not submitted".
 */
const optionalDate = z.preprocess(
  (v) => (v === "" || v === null ? null : typeof v === "string" ? new Date(v) : v),
  z.union([z.date(), z.null()]).optional(),
);

/** `color` — `#RRGGBB` or absent. The picker sends exactly this shape. */
const optionalColor = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, msgKey("work.err.colorFormat"))
    .optional(),
);

const dueAtAfterStartAt = (
  data: { startAt?: Date | null; dueAt?: Date | null },
  ctx: z.RefinementCtx,
) => {
  if (data.startAt && data.dueAt && data.dueAt < data.startAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dueAt"],
      message: msgKey("work.err.dueBeforeStart"),
    });
  }
};

/** ── Create / edit ─────────────────────────────────────────────────────────── */

const projectCreateObject = z.object({
  name: z.string().trim().min(1, msgKey("work.err.nameRequired")),
  description: optionalText,
  /** Defaults to `REQUESTED` — the enum's own `@default`. */
  status: z.preprocess(emptyToUndefined, z.enum(ProjectStatus).default("REQUESTED")),
  color: optionalColor,
  startAt: optionalDate,
  dueAt: optionalDate,
  leadId: optionalId,
  parentProjectId: optionalId,
});

export const projectCreateSchema = projectCreateObject.superRefine(dueAtAfterStartAt);

/**
 * Edit: every field a project owns except `status` (dedicated mutation) and
 * `slug` (stable on rename — the URL a link was shared with is the slug's
 * reason for existing). `parentProjectId` IS editable here — the
 * self/descendant refusal lives in `updateProject`, the same shape
 * `Location.parentId` gets from `moveLocation`.
 */
export const projectEditSchema = projectCreateObject
  .omit({ status: true })
  .extend({ id: z.string().min(1) })
  .superRefine(dueAtAfterStartAt);

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectEditInput = z.infer<typeof projectEditSchema>;

/** ── Status change ─────────────────────────────────────────────────────────── */

export const projectStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(ProjectStatus),
});

export type ProjectStatusInput = z.infer<typeof projectStatusSchema>;

/** ── List options ──────────────────────────────────────────────────────────── */

export const projectListOptionsSchema = z.object({
  status: z.preprocess(emptyToUndefined, z.enum(ProjectStatus).optional()),
  leadId: optionalId,
  q: optionalText,
});

export type ProjectListOptions = z.infer<typeof projectListOptionsSchema>;
