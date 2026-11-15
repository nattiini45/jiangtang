import { z } from "zod";
import { msgKey } from "~/i18n";

const name = z
  .string()
  .trim()
  .min(1, msgKey("admin.structure.nameInvalid"))
  .max(60, msgKey("admin.structure.nameInvalid"));
const id = z.string().trim().min(1);
export const groupCreateSchema = z.object({ name });
export const groupUpdateSchema = z.object({
  name: name.optional(),
  position: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
});
export const kindCreateSchema = groupCreateSchema.extend({ groupId: id });
export const kindUpdateSchema = groupUpdateSchema.extend({
  groupId: id.optional(),
  moveDevicesTo: id.optional(),
});
export const structureActionSchema = z.object({
  intent: z.enum(["create", "update", "archive", "restore", "delete", "reorder"]),
  entity: z.enum(["kind", "group"]),
  id: id.optional(),
  name: z.string().optional(),
  groupId: z.string().optional(),
  moveDevicesTo: z.string().optional(),
  position: z.coerce.number().int().min(0).optional(),
});
