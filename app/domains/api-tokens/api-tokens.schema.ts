import { z } from "zod";
import { msgKey } from "~/i18n";

export const tokenCreateSchema = z.object({
  name: z.string().trim().min(1, msgKey("err.invalidInput")).max(120, msgKey("err.invalidInput")),
  scope: z.enum(["READ_ONLY", "READ_WRITE"], { error: msgKey("err.invalidInput") }),
});

export type TokenCreateInput = z.infer<typeof tokenCreateSchema>;

export interface TokenActor {
  id: string;
  name: string;
  email?: string | null;
  initials?: string | null;
  role: "ADMIN" | "MEMBER";
}
