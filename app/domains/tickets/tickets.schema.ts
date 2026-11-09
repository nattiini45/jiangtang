import { z } from "zod";
import { msgKey } from "~/i18n";
import { TicketStatus, TicketType } from "~/generated/prisma/enums";

/**
 * Zod schemas for the tickets domain. Form values arrive as strings / string[].
 *
 * The model splits along a content-vs-workflow axis:
 *  - `ticketContent` — fields edited freely (type, title, links, assignees…).
 *  - `ticketCreateSchema` — content + the born-resolved fields (status / resolution
 *    / resolvedAt); a REPAIR can be logged already-resolved.
 *  - `ticketTransitionSchema` — a guarded status move (resolve / start / reopen /
 *    cancel) that owns the resolvedAt side-effect; never edited via the content form.
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalDate = z.preprocess(emptyToUndefined, z.coerce.date().optional());
const optionalPriority = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number()
    .int()
    .min(1, msgKey("work.err.ticket.priorityRange"))
    .max(3, msgKey("work.err.ticket.priorityRange"))
    .optional(),
);
// Repeated form keys (multi-select / checkbox group) collapse to string[]; a lone
// value arrives as a string. Normalize either to a trimmed, non-empty id array.
const idArray = z.preprocess((v) => {
  const arr = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
}, z.array(z.string()));

// ── Content (shared by create + edit) ─────────────────────────────────────────
const ticketContent = z.object({
  type: z.enum(TicketType).default(TicketType.INCIDENT),
  title: z.string().trim().min(1, msgKey("work.err.titleRequired")),
  description: optionalText,
  priority: optionalPriority,
  roomId: optionalId,
  equipmentId: optionalId,
  eventId: optionalId,
  reporterId: optionalId,
  assigneeIds: idArray,
  // Logical time — may be back-dated when logging a past repair.
  occurredAt: optionalDate,
});

export const ticketEditSchema = ticketContent;

// ── Create (content + born-resolved) ──────────────────────────────────────────
export const ticketCreateSchema = ticketContent
  .extend({
    status: z.enum(TicketStatus).default(TicketStatus.OPEN),
    resolution: optionalText,
    resolvedAt: optionalDate,
  })
  .superRefine((t, ctx) => {
    if (t.status === TicketStatus.RESOLVED && !t.resolution) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: msgKey("work.err.ticket.resolutionRequiredResolved"),
      });
    }
    if (t.occurredAt && t.resolvedAt && t.resolvedAt < t.occurredAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedAt"],
        message: msgKey("work.err.ticket.resolvedBeforeOccurred"),
      });
    }
  });

// ── Status transition (guarded; resolve / start / reopen / cancel) ─────────────
export const ticketTransitionSchema = z.object({
  status: z.enum(TicketStatus),
  resolution: optionalText,
});

export type TicketContentInput = z.infer<typeof ticketContent>;
export type TicketEditInput = z.infer<typeof ticketEditSchema>;
export type TicketCreateInput = z.infer<typeof ticketCreateSchema>;
export type TicketTransitionInput = z.infer<typeof ticketTransitionSchema>;
