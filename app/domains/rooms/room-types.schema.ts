import { z } from "zod";

export const expectationSchema = z.object({
  functionId: z.string().min(1),
  expected: z.boolean().nullable(),
  note: z.string().trim().max(1000).optional(),
});
export const roomExpectationsInput = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, z.array(expectationSchema).max(100).optional());
export const setRoomTypeSchema = z.object({
  roomIds: z.array(z.string().min(1)).min(1).max(500),
  roomTypeId: z.string().min(1).nullable(),
});
