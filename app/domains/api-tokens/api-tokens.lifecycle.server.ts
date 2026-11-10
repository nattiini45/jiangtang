import type { Tx } from "~/lib/db.server";
import type { AuditFn } from "~/lib/audit.server";
import { ENTITY_TYPE } from "~/domains/tickets/tickets.history.server";

export type TokenLifecycleReason =
  "USER_DEACTIVATED" | "USER_PSEUDONYMIZED" | "PASSWORD_RESET_ISSUED" | "PASSWORD_RESET_COMPLETED";

export async function revokeUserPersonalAccessTokens(
  tx: Tx,
  audit: AuditFn,
  userId: string,
  reason: TokenLifecycleReason,
): Promise<number> {
  const revoked = await tx.personalAccessToken.updateManyAndReturn({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
    select: { id: true, scope: true },
  });
  for (const token of revoked) {
    await audit({
      action: "PersonalAccessTokenRevoked",
      entityType: ENTITY_TYPE.user,
      entityId: userId,
      data: { tokenId: token.id, scope: token.scope, reason },
    });
  }
  return revoked.length;
}
