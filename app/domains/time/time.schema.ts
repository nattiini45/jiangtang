import { z } from "zod";
import { msgKey } from "~/i18n";

/**
 * Zod schemas for the time domain. Form values arrive as Berlin
 * wall-clock `date` + `startTime`/`endTime` strings; the ROUTE converts them
 * to UTC instants through `berlinLocalToUtc` and the domain works in Dates —
 * this file only validates the shapes both layers share.
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, msgKey("work.err.dateFormat"));

const timeField = z.string().regex(/^\d{2}:\d{2}$/, msgKey("work.err.timeFormat"));

const optionalTimeField = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d{2}:\d{2}$/, msgKey("work.err.timeFormat"))
    .optional(),
);

/** "Eintrag hinzufügen" / inline edit on /timesheet — Berlin wall-clock fields. */
export const timeEntryFormSchema = z.object({
  id: optionalId,
  date: dateField,
  startTime: timeField,
  // Absent end = a running timer is being recorded manually.
  endTime: optionalTimeField,
  taskId: optionalId,
  comment: z.preprocess(
    (v) => (v == null ? null : String(v).trim() || null),
    z.string().max(2000).nullable(),
  ),
  /** Admin-only target user; ignored for non-admins by the mutation. */
  userId: optionalId,
});
export type TimeEntryFormInput = z.infer<typeof timeEntryFormSchema>;

/** Domain-level input: real instants, validated for order. */
export const timeEntryInputSchema = z
  .object({
    startsAt: z.date(),
    endsAt: z.date().nullable(),
    taskId: optionalId,
    comment: z.string().max(2000).nullable().optional(),
    userId: optionalId,
  })
  .refine((v) => v.endsAt == null || v.endsAt > v.startsAt, {
    message: msgKey("work.err.endsAfterStart"),
    path: ["endsAt"],
  });
export type TimeEntryInput = z.infer<typeof timeEntryInputSchema>;

export const timerStartSchema = z.object({ taskId: optionalId });
export const timeEntryIdSchema = z.string().min(1);
