import { z } from "zod";

export const smtpSchema = z.object({
  host: z
    .string()
    .trim()
    .max(253)
    .regex(/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/i),
  port: z.coerce.number().int().min(1).max(65535),
  tls: z.enum(["starttls", "tls"]),
  from: z.email().max(254),
  username: z.string().trim().max(512),
  password: z.string().max(1024),
});

export const storedSmtpSchema = smtpSchema.extend({
  revision: z.uuid(),
  enabled: z.boolean(),
});

export type SmtpConfig = z.output<typeof storedSmtpSchema>;

const checkbox = z.literal("on").optional().transform(Boolean);
export const mailActionSchema = z.discriminatedUnion("intent", [
  smtpSchema.extend({
    intent: z.literal("save"),
    enabled: checkbox,
    clearPassword: checkbox,
  }),
  z.object({ intent: z.literal("test") }),
]);
