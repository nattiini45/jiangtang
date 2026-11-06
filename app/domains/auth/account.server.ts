import { APIError } from "better-auth";
import { auth, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type AuthUser } from "~/lib/auth.server";
import { txWithAudit } from "~/lib/audit.server";
import { ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { msgKey } from "~/i18n";
import { z } from "~/lib/validation.server";

/**
 * Self-service account changes for the signed-in user. The password itself is
 * owned by Better Auth (hashing, credential lookup, session rotation), so the
 * change goes through its `changePassword` endpoint; the audit row follows once
 * that has succeeded.
 */

export const changePasswordSchema = z
  .object({
    // Longer than any stored password can be; Better Auth refuses it with an error
    // of its own, so it is answered here as a wrong password.
    currentPassword: z
      .string()
      .min(1, msgKey("account.password.err.currentRequired"))
      .max(MAX_PASSWORD_LENGTH, msgKey("account.password.err.currentWrong")),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, msgKey("places.err.auth.passwordMin"))
      .max(MAX_PASSWORD_LENGTH, msgKey("places.err.auth.passwordMax")),
    confirm: z.string().min(1, msgKey("places.err.auth.passwordMismatch")),
  })
  .refine((d) => d.newPassword === d.confirm, {
    message: msgKey("places.err.auth.passwordMismatch"),
    path: ["confirm"],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Change the signed-in user's password. Requires the current password and
 * signs out every other session; the browser that made the change gets a new
 * session, whose cookie is in the returned headers. A wrong current password
 * throws a ValidationError on `currentPassword`.
 */
export async function changeOwnPassword(
  user: AuthUser,
  request: Request,
  input: ChangePasswordInput,
): Promise<Headers> {
  let headers: Headers;
  try {
    ({ headers } = await auth.api.changePassword({
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
      },
      headers: request.headers,
      returnHeaders: true,
    }));
  } catch (e) {
    if (e instanceof APIError && e.body?.code === "INVALID_PASSWORD") {
      throw new ValidationError({
        currentPassword: [tr("account.password.err.currentWrong")],
      });
    }
    throw e;
  }

  await txWithAudit(
    { id: user.id, name: user.name, email: user.email, initials: user.initials },
    async (_tx, audit) => {
      await audit({
        action: "PasswordChanged",
        entityType: "user",
        entityId: user.id,
        data: { otherSessionsRevoked: true },
      });
    },
  );
  return headers;
}
