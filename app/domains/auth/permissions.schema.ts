import { z } from "zod";

export const TIME_PERMISSIONS = ["time.viewOthers", "time.editOthers"] as const;
export const timePermissionSchema = z.enum(TIME_PERMISSIONS);
export const timePermissionFormSchema = z.object({
  permission: timePermissionSchema,
  enabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});
