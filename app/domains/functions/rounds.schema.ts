import { z } from "zod";

export const startRoundSchema = z.object({
  name: z.string().trim().min(1).max(200),
  roomIds: z.array(z.string().min(1)).min(1).max(1000),
});

export const recordCheckSchema = z.object({
  roomId: z.string().min(1),
  functionId: z.string().min(1),
  roundId: z.string().min(1).optional(),
  result: z.enum(["WORKS", "LIMITED", "DOWN", "NOT_CHECKED"]),
  note: z.string().trim().max(5000).optional(),
  resolution: z.string().trim().max(5000).optional(),
  resolveFaults: z.array(z.string()).default([]),
  restoreDevices: z.array(z.string()).default([]),
});

export const functionStateSchema = z.object({
  roomId: z.string().min(1),
  functionId: z.string().min(1),
  state: z.enum(["WORKS", "LIMITED", "DOWN"]),
  reason: z.string().trim().min(1).max(5000),
  until: z.coerce.date().optional(),
});
