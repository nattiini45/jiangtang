import { z } from "zod";
import { msgKey } from "~/i18n";
import { EventStatus, ServiceWindowKind } from "~/generated/prisma/enums";

/**
 * Zod schemas for the events domain. Datetime fields are kept as Berlin
 * wall-clock `datetime-local` strings ("YYYY-MM-DDTHH:mm"); the mutation layer
 * converts them to UTC instants via berlinLocalToUtc (golden rule: all times are
 * Europe/Berlin). This file stays pure (no server-only imports) so the form
 * components can share its inferred types.
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());

// Berlin wall-clock datetime-local string. Compared by naive parse — both sides
// parse in the same (irrelevant) zone, so the ordering is correct regardless.
const dtLocal = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, msgKey("work.err.event.dateTimeRequired"));

const endsAfterStarts = (r: { startsAt: string; endsAt: string }) =>
  new Date(r.startsAt).getTime() < new Date(r.endsAt).getTime();
const endsAfterStartsIssue = {
  message: msgKey("work.err.endsAfterStart"),
  path: ["endsAt"],
};

// ── Event ──────────────────────────────────────────────────────────────────
export const eventCreateSchema = z
  .object({
    title: z.string().trim().min(1, msgKey("work.err.titleRequired")),
    description: optionalText,
    startsAt: dtLocal,
    endsAt: dtLocal,
    status: z.nativeEnum(EventStatus).default(EventStatus.PLANNED),
    organizer: optionalText,
    contact: optionalText,
  })
  .refine(endsAfterStarts, endsAfterStartsIssue);

export const eventEditSchema = eventCreateSchema;

// ── Bookable atoms ───────────────────────────────────────────────────────────
export const roomBookingSchema = z
  .object({
    roomId: z.string().min(1, msgKey("work.err.event.roomRequired")),
    startsAt: dtLocal,
    endsAt: dtLocal,
  })
  .refine(endsAfterStarts, endsAfterStartsIssue);

export const allocationSchema = z
  .object({
    equipmentId: z.string().min(1, msgKey("work.err.event.equipmentRequired")),
    startsAt: dtLocal,
    endsAt: dtLocal,
  })
  .refine(endsAfterStarts, endsAfterStartsIssue);

export const serviceWindowSchema = z
  .object({
    roomId: optionalId,
    kind: z.nativeEnum(ServiceWindowKind).default(ServiceWindowKind.SETUP),
    startsAt: dtLocal,
    endsAt: dtLocal,
    coveringUserId: optionalId,
    notes: optionalText,
  })
  .refine(endsAfterStarts, endsAfterStartsIssue);

export type EventCreateInput = z.infer<typeof eventCreateSchema>;
export type EventEditInput = z.infer<typeof eventEditSchema>;
export type RoomBookingInput = z.infer<typeof roomBookingSchema>;
export type AllocationInput = z.infer<typeof allocationSchema>;
export type ServiceWindowInput = z.infer<typeof serviceWindowSchema>;
