import { msgKey } from "~/i18n";
import { z } from "~/lib/validation.server";

/**
 * Zod schemas for the admin user-management forms. Field names match
 * the HTML `<input name=…>` in the route components and `safeParseForm` keys.
 */

export const INVITE_ID = "invite";

export const inviteSchema = z.object({
  email: z.string().email(msgKey("places.err.auth.emailRequired")),
  name: z.string().min(1, msgKey("places.err.auth.nameRequired")).max(120),
  initials: z
    .string()
    .min(2, msgKey("places.err.auth.initialsMin"))
    .max(6, msgKey("places.err.auth.initialsMax"))
    .regex(/^[A-ZÄÖÜa-zäöü]+$/, msgKey("places.err.auth.initialsLetters")),
  role: z.enum(["ADMIN", "MEMBER"]),
});

export const acceptInviteSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(8, msgKey("places.err.auth.passwordMin")),
    confirm: z.string().min(1),
  })
  .refine((d) => d.password === d.confirm, {
    message: msgKey("places.err.auth.passwordMismatch"),
    path: ["confirm"],
  });

/**
 * Typed confirmation for the irreversible erasure action. The route
 * validates `confirmEmail` against the target user's actual email server-side
 * (the equality check needs the loaded user, so it's not expressible as a pure
 * schema refinement here — see the erase route action).
 */
export const eraseUserSchema = z.object({
  confirmEmail: z.string().min(1, msgKey("places.err.auth.confirmEmail")),
});

export const editUserSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER"]),
  initials: z
    .string()
    .min(2, msgKey("places.err.auth.initialsMin"))
    .max(6, msgKey("places.err.auth.initialsMax"))
    .regex(/^[A-ZÄÖÜa-zäöü]+$/, msgKey("places.err.auth.initialsLetters")),
  // The admin edit form posts the native <select> value as a string; coerce it
  // to a real boolean here so callers never need to string-compare.
  isActive: z.enum(["true", "false"]).transform((v) => v === "true"),
  // The admin form posts hours per week; stored as minutes on User.
  // Empty string → null (capacity unset — renders „keine Kapazität").
  weeklyCapacityHours: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.coerce
      .number()
      .min(0, msgKey("places.err.auth.capacityNegative"))
      .max(168, msgKey("places.err.auth.capacityMax"))
      .nullable(),
  ),
});

export type InviteInput = z.infer<typeof inviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type EditUserInput = z.infer<typeof editUserSchema>;
export type EraseUserInput = z.infer<typeof eraseUserSchema>;
