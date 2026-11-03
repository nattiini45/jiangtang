import { z } from "zod";
import { msgKey } from "~/i18n";
import { TaskPriority, TaskStatus } from "~/generated/prisma/enums";
import { berlinLocalToUtc } from "~/lib/time.server";
import { TASK_PRIORITY_ALIASES, TASK_STATUS_ALIASES } from "~/lib/status";
import { LANES } from "./tasks.lanes";

/**
 * Zod schemas for the tasks domain (`Task` — planned work, sibling
 * to Ticket). Same conventions as the projects schema: form values arrive as
 * strings, so optional fields are preprocessed out of empty strings.
 *
 * **`status` is create-time-only here** — same division of labour as projects:
 * on edit it is absent because a transition goes through `setTaskStatus` (or a
 * lane drop through `moveTask`) so every change is audited `TaskStatusChanged`
 * / `TaskMoved` rather than folded into an `updateTask` diff.
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());

/**
 * An optional date: `Date` (server path) or a string (form path); `""`/`null`
 * mean "cleared" and pass through as `null` so the mutation can distinguish
 * "cleared" from "not submitted".
 *
 * Task dates are DAY-granular Berlin: a `type="date"` value `YYYY-MM-DD` is
 * stored as 00:00 Europe/Berlin of that day, NOT as host-local or UTC
 * midnight. A `datetime-local` wall-clock string is read as Berlin time the
 * same way; a fully-offset ISO instant is taken verbatim. An unparseable
 * string becomes an Invalid Date and the union below refuses it as a field
 * error rather than a 500.
 */
const optionalDate = z.preprocess(
  (v) => {
    if (v === "" || v === null) return null;
    if (typeof v === "string") {
      try {
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return berlinLocalToUtc(`${v}T00:00`);
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) return berlinLocalToUtc(v);
      } catch {
        return new Date(Number.NaN);
      }
      return new Date(v);
    }
    return v;
  },
  z
    .union([z.date(), z.null()])
    .refine((v) => v === null || !Number.isNaN(v.getTime()), {
      message: msgKey("work.err.invalidDate"),
    })
    .optional(),
);

/** `estimateMinutes` — integer ≥ 0, or absent/`""`. */
const optionalEstimate = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number()
    .int(msgKey("work.err.minutesInteger"))
    .min(0, msgKey("work.err.minutesNegative"))
    .optional(),
);

/**
 * `labels` from repeated form keys — the `tags` pitfall handled IN the
 * schema (there is no CSV-column decision to protect here the way stock had):
 * `formDataToObject` collapses N inputs into an array but leaves ONE input a
 * bare string, so both shapes are normalised here — trimmed, blanks dropped,
 * deduped — and one blank box can never reject the save.
 */
const labelsField = z.preprocess((v) => {
  const list = v === undefined ? undefined : Array.isArray(v) ? v : [v];
  if (list === undefined) return undefined;
  const cleaned = list
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  return [...new Set(cleaned)];
}, z.array(z.string()).default([]));

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

const taskCreateObject = z.object({
  title: z
    .string()
    .trim()
    .min(1, msgKey("work.err.titleRequired"))
    .max(200, msgKey("work.err.titleTooLong")),
  body: z.preprocess(emptyToUndefined, z.string().trim().max(20000).optional()),
  status: z.preprocess(emptyToUndefined, z.enum(TaskStatus).default("BACKLOG")),
  priority: z.preprocess(emptyToUndefined, z.enum(TaskPriority).optional()),
  startAt: optionalDate,
  dueAt: optionalDate,
  estimateMinutes: optionalEstimate,
  projectId: optionalId,
  parentTaskId: optionalId,
  locationId: optionalId,
  labels: labelsField,
});

export const taskCreateSchema = taskCreateObject.superRefine(dueAtAfterStartAt);

/**
 * Edit: content fields only. `status` is deliberately absent (`setTaskStatus`
 * / `moveTask` own it) and so is `position` (`moveTask` owns it).
 * `parentTaskId` IS editable — the self/descendant refusal lives in
 * `updateTask`, the same shape `Project.parentProjectId` gets from
 * `updateProject`.
 */
export const taskEditSchema = taskCreateObject
  .omit({ status: true })
  .extend({ id: z.string().min(1) })
  .superRefine(dueAtAfterStartAt);

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskEditInput = z.infer<typeof taskEditSchema>;

/** ── Status / move / assignees ─────────────────────────────────────────────── */

export const taskStatusSchema = z.object({
  status: z.enum(TaskStatus),
});

export const taskMoveSchema = z
  .object({
    lane: z.enum(LANES),
    /** The card this one goes AFTER in lane order (top edge: absent). */
    afterId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    /** The card this one goes BEFORE in lane order (bottom edge: absent). */
    beforeId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  })
  .refine((v) => !(v.afterId && v.beforeId && v.afterId === v.beforeId), {
    message: msgKey("work.err.task.betweenItself"),
    path: ["afterId"],
  });

export type TaskMoveInput = z.infer<typeof taskMoveSchema>;

/** One assignee entry — `estimateMinutes` is that assignee's share. */
export const taskAssigneeSchema = z.object({
  userId: z.string().min(1),
  estimateMinutes: optionalEstimate,
});

export const taskAssigneesSchema = z.array(taskAssigneeSchema);

export type TaskAssigneeInput = z.infer<typeof taskAssigneeSchema>;

/** ── List options ──────────────────────────────────────────────────────────── */

const statusesField = z.preprocess(
  (v) => {
    const list = v === undefined ? undefined : Array.isArray(v) ? v : [v];
    return list?.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  },
  z.array(z.enum(TaskStatus)).optional(),
);

export const taskListOptionsSchema = z.object({
  projectId: optionalId,
  statuses: statusesField,
  assigneeId: optionalId,
  label: optionalText,
  q: optionalText,
  dueFrom: optionalDate,
  dueTo: optionalDate,
});

export type TaskListOptions = z.infer<typeof taskListOptionsSchema>;

/** ── CSV import ────────────────────────────────────────────────────────────── */

/**
 * An enum cell accepts the enum value OR its German or English label,
 * case-insensitively and whatever language the importing user's UI is in (the
 * stock importer's contract, one enum over). An empty cell is "not given",
 * anything else is a row error naming the value it could not read.
 */
function enumOrLabel<E extends z.util.EnumLike>(
  enumObj: E,
  aliases: { resolve(cell: string): string | null },
  invalid: string,
) {
  return z.preprocess(
    (v) => {
      if (typeof v !== "string" || v.trim() === "") return undefined;
      return aliases.resolve(v) ?? v.trim();
    },
    z.enum(enumObj, { error: () => invalid }).optional(),
  );
}

/**
 * An estimate cell: `90` or `90m` minutes, `1h30`, `1,5h` / `1.5h` hours —
 * all become whole minutes. A cell that matches none of the four spellings is
 * a row error; a fractional result rounds to the minute.
 */
const csvEstimate = z.preprocess(
  (v) => {
    if (typeof v !== "string" || v.trim() === "") return undefined;
    const s = v.trim().toLowerCase().replace(",", ".");
    let m = /^(\d+(?:\.\d+)?)h(?:(\d+)\s*m?)?$/.exec(s);
    if (m) return Math.round(parseFloat(m[1]) * 60) + (m[2] ? parseInt(m[2], 10) : 0);
    m = /^(\d+)\s*m?$/.exec(s);
    if (m) return parseInt(m[1], 10);
    return v;
  },
  z
    .number()
    .int(msgKey("work.err.minutesInteger"))
    .min(0, msgKey("work.err.minutesNegative"))
    .optional(),
);

/** A day cell: ISO `YYYY-MM-DD` or German `DD.MM.YYYY`, stored as Berlin 00:00. */
const csvDay = z.preprocess(
  (v) => {
    if (typeof v !== "string" || v.trim() === "") return undefined;
    const s = v.trim();
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    const de = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    const day = iso ?? (de ? `${de[3]}-${de[2]}-${de[1]}` : null);
    if (day === null) return new Date(Number.NaN);
    try {
      return berlinLocalToUtc(`${day}T00:00`);
    } catch {
      return new Date(Number.NaN);
    }
  },
  z.date({ error: () => msgKey("work.err.csvDayFormat") }).optional(),
);

/** A comma/semicolon list cell — trimmed, blanks dropped, deduped. */
const csvList = z.preprocess((v) => {
  if (typeof v !== "string") return [];
  return [
    ...new Set(
      v
        .split(/[;,]/)
        .map((t) => t.trim())
        .filter((t) => t !== ""),
    ),
  ];
}, z.array(z.string()));

/**
 * The tasks CSV row — keyed by the column names the route's HEADER declares.
 * `assignees` stays a string list here (initials or emails) and `project` a
 * slug: resolving them needs the database, and the domain module resolves
 * them — naming the row — the way `bulkCreateStock` resolves its FKs.
 */
export const taskCsvRowSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, msgKey("work.err.titleRequired"))
      .max(200, msgKey("work.err.titleTooLong")),
    status: enumOrLabel(TaskStatus, TASK_STATUS_ALIASES, msgKey("work.err.csv.statusUnknown")),
    priority: enumOrLabel(
      TaskPriority,
      TASK_PRIORITY_ALIASES,
      msgKey("work.err.csv.priorityUnknown"),
    ),
    start: csvDay,
    due: csvDay,
    estimate: csvEstimate,
    labels: csvList,
    assignees: csvList,
    project: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  })
  .superRefine((data, ctx) => {
    if (data.start && data.due && data.due < data.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["due"],
        message: msgKey("work.err.dueBeforeStart"),
      });
    }
  });

export type TaskCsvRow = z.infer<typeof taskCsvRowSchema>;
