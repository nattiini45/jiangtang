import { z } from "zod";
import { berlinLocalToUtc, utcToBerlinLocal } from "~/lib/time.server";

export const planDate = z.iso.date().transform((value, ctx) => {
  const date = berlinLocalToUtc(`${value}T00:00`);
  if (!Number.isFinite(+date) || utcToBerlinLocal(date).slice(0, 10) !== value) {
    ctx.addIssue({ code: "custom", message: "Invalid date" });
    return z.NEVER;
  }
  return date;
});

export const planSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    workType: z.enum(["round", "inspection"]),
    target: z.enum(["rooms", "portable", "kind", "devices"]),
    intervalMonths: z.coerce.number().int().min(1).max(120).nullable(),
    semester: z.boolean(),
    startsAt: z.date(),
    basis: z.string().trim().min(1).max(4000),
    sourceUrl: z.url().refine((value) => /^https?:\/\//i.test(value)),
    assigneeId: z.string().nullable(),
    kindId: z.string().nullable(),
    roomIds: z.array(z.string().min(1)).max(500),
    equipmentIds: z.array(z.string().min(1)).max(5000),
  })
  .superRefine((value, ctx) => {
    if (
      (!value.semester && !value.intervalMonths) ||
      (value.semester && value.intervalMonths !== null) ||
      (value.workType === "round" && value.target !== "rooms") ||
      (value.workType === "inspection" && value.target === "rooms") ||
      (value.target === "kind" && !value.kindId) ||
      (value.target === "devices" && !value.equipmentIds.length)
    )
      ctx.addIssue({ code: "custom", message: "Invalid plan" });
  });
