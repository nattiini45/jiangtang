import { z } from "zod";
import { msgKey } from "~/i18n";
import { optionalHttpUrl } from "~/lib/validation.server";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

export const vendorCreateSchema = z.object({
  name: z.string().trim().min(1, msgKey("places.err.name.required")),
  contact: optionalText,
  email: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .pipe(z.email(msgKey("places.err.auth.emailRequired")))
      .optional(),
  ),
  phone: optionalText,
  url: optionalHttpUrl,
  address: optionalText,
  locationId: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
});

export const vendorEditSchema = vendorCreateSchema.extend({ id: z.string().trim().min(1) });

export type VendorCreateInput = z.infer<typeof vendorCreateSchema>;
export type VendorEditInput = z.infer<typeof vendorEditSchema>;
