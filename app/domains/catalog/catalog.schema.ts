import { z } from "zod";
import { msgKey } from "~/i18n";
import { EquipmentCategory } from "~/generated/prisma/enums";
import { optionalHttpUrl } from "~/lib/validation.server";

/** Zod schemas for the EquipmentModel catalog. Form values arrive as strings. */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalUrl = optionalHttpUrl;

export const modelCreateSchema = z.object({
  manufacturer: optionalText,
  name: z.string().trim().min(1, msgKey("places.err.name.required")),
  category: z.enum(EquipmentCategory),
  specNotes: optionalText,
  manualUrl: optionalUrl,
});

export const modelEditSchema = modelCreateSchema;

export type ModelCreateInput = z.infer<typeof modelCreateSchema> & { kindId?: string };
export type ModelEditInput = ModelCreateInput;
