import { z } from "zod";
import { msgKey } from "~/i18n";
import { allocationSchema, eventCreateSchema, roomBookingCreateSchema } from "./events.schema";

export const seriesDate = z.iso.date();
const localTime = z.iso
  .datetime({ local: true })
  .refine(
    (value) => !value.endsWith("Z") && value.length <= 19,
    msgKey("work.err.event.dateTimeRequired"),
  );
export const seriesEventSchema = z
  .object({
    ...eventCreateSchema.shape,
    startsAt: localTime,
    endsAt: localTime,
    startsAtInstant: z.never().optional(),
    endsAtInstant: z.never().optional(),
    status: z.enum(["PLANNED", "CONFIRMED"]).default("PLANNED"),
  })
  .refine(({ startsAt, endsAt }) => Date.parse(startsAt + "Z") < Date.parse(endsAt + "Z"), {
    path: ["endsAt"],
    message: msgKey("work.err.endsAfterStart"),
  });

const { healthOverrideConfirmed, healthOverrideReason } = roomBookingCreateSchema.shape;
const override = { healthOverrideConfirmed, healthOverrideReason };
const rule = z.discriminatedUnion("frequency", [
  z.object({ frequency: z.literal("daily") }),
  z.object({
    frequency: z.literal("weekly"),
    interval: z.number().int().min(1).max(52),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  }),
  z.object({ frequency: z.literal("monthly") }),
]);
const end = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), date: seriesDate }),
  z.object({ kind: z.literal("count"), count: z.number().int().min(1).max(1000) }),
]);
export const eventSeriesSchema = z
  .object({
    event: seriesEventSchema,
    rule,
    end,
    rooms: z
      .array(z.object({ roomId: roomBookingCreateSchema.shape.roomId, ...override }))
      .max(10)
      .default([]),
    equipment: z
      .array(z.object({ equipmentId: allocationSchema.shape.equipmentId, ...override }))
      .max(10)
      .default([]),
  })
  .refine(({ event, end }) => end.kind !== "date" || end.date >= event.startsAt.slice(0, 10), {
    path: ["end", "date"],
    message: msgKey("work.err.endsAfterStart"),
  })
  .refine(
    ({ rooms, equipment }) =>
      new Set(rooms.map((room) => room.roomId)).size === rooms.length &&
      new Set(equipment.map((item) => item.equipmentId)).size === equipment.length,
  );

export type EventSeriesInput = z.output<typeof eventSeriesSchema>;
