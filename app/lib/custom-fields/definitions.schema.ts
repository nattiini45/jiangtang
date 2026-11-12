import { z } from "zod";
import { msgKey } from "~/i18n";

export const fieldString = z
  .string()
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    msgKey("fields.error.encoding"),
  );

export const fieldScope = z.enum(["ROOM", "EQUIPMENT"]);
export const fieldType = z.enum([
  "TEXT",
  "LONG_TEXT",
  "NUMBER",
  "BOOLEAN",
  "CHOICE",
  "MULTI_CHOICE",
  "DATE",
  "LINK",
]);
const label = fieldString
  .trim()
  .min(1, msgKey("fields.admin.labelInvalid"))
  .max(80, msgKey("fields.admin.labelInvalid"));
const position = z.int32();
const properties = z.object({
  name: label,
  helpText: fieldString.max(300).nullable().optional(),
  section: fieldString.max(60).nullable().optional(),
  unit: fieldString.max(12).nullable().optional(),
  position: position.default(0),
  showInList: z.boolean().default(false),
  listPosition: position.nullable().optional(),
  searchable: z.boolean().default(true),
  kindIds: z.array(z.string().min(1)).max(80).default([]),
});
export const createFieldSchema = properties.extend({
  scope: fieldScope,
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  type: fieldType,
});
export const updateFieldSchema = properties
  .partial()
  .extend({
    position: position.optional(),
    showInList: z.boolean().optional(),
    searchable: z.boolean().optional(),
    kindIds: z.array(z.string().min(1)).optional(),
    id: z.string().min(1),
    archived: z.boolean().optional(),
    type: fieldType.optional(),
  })
  .strict();
export const fieldOptionsSchema = z.object({
  fieldId: z.string().min(1),
  changes: z
    .array(
      z.discriminatedUnion("op", [
        z.object({ op: z.literal("add"), label, position: position.default(0) }),
        z.object({
          op: z.literal("update"),
          id: z.string().min(1),
          label: label.optional(),
          position: position.optional(),
          archived: z.boolean().optional(),
        }),
        z.object({ op: z.literal("delete"), id: z.string().min(1) }),
      ]),
    )
    .min(1)
    .max(200),
});
