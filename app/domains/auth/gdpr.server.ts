import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { assertCanChangeAdminStatus } from "~/domains/auth/users.queries.server";
import { ENTITY_TYPE } from "~/domains/tickets/tickets.history.server";

/**
 * The retention prune has no logged-in session — it runs from the daily
 * boot job (retention.boot.server.ts). This is the documented system actor for
 * that job's own audit row (distinct from a real user; `id` stays unset so it
 * never collides with/impersonates an actual User row).
 */
const RETENTION_SYSTEM_ACTOR: AuditActor = { name: "System (Retention Job)", initials: "SYS" };

/**
 * GDPR erasure / pseudonymization. The ActivityLog is append-only by
 * default (REVOKE + trigger); the `pseudonymize_actor` SECURITY DEFINER function
 * (20261023000300_audit_privacy) is the one sanctioned escape hatch. It rewrites an actor's
 * snapshot to initials-only — dropping name/email but keeping the initials so
 * historical attribution survives — pseudonymization, not deletion.
 *
 * `pseudonymizeUser` is the admin-facing operation: pseudonymize the audit
 * history, detach the user's ticket links, scrub the User row, deactivate.
 */

const PSEUDO_MARKER = "[pseudonymisiert]";

export interface PseudonymizeResult {
  userId: string;
  auditRowsAffected: number;
}

export async function pseudonymizeUser(
  actor: AuditActor,
  userId: string,
): Promise<PseudonymizeResult> {
  return txWithAudit(actor, async (tx, audit) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError(tr("places.err.user.notFound"));

    // An admin may not erase themselves, nor the sole remaining active
    // admin. Erasure deactivates the account, so the same lockout guard as
    // demotion/deactivation applies.
    await assertCanChangeAdminStatus(tx, userId, actor, { isActive: false });

    // 1. Pseudonymize the audit history via the privileged function (the only path
    //    past the immutability trigger). Snapshot -> initials-only. Runs on `tx`:
    //    the function sets the transaction-local jiangtang.audit_bypass GUC,
    //    which stays set for the rest of THIS transaction, so steps 2-4 below plus
    //    this call all commit or roll back together.
    const [row] = (await tx.$queryRaw`SELECT pseudonymize_actor(${userId}) AS affected`) as Array<{
      affected: number;
    }>;
    const auditRowsAffected = Number(row?.affected ?? 0);

    // 2. Detach the user's ticket links (reporter + assignee). Tickets themselves
    //    stay (they're operational history), but the personal link is severed.
    await tx.ticket.updateMany({ where: { reporterId: userId }, data: { reporterId: null } });
    // Assignees is a m2m relation table (_Assignees); remove this user's links.
    await tx.$executeRaw`DELETE FROM "_Assignees" WHERE "B" = ${userId}`;
    // attachments follow the same contract as the sibling createdById
    // relations (Task/TimeEntry/…): the record and its storage object stay,
    // only the creator link is nulled. The Attachment_createdById_fkey FK
    // (ON DELETE SET NULL) pins the same rule at the database level.
    await tx.attachment.updateMany({ where: { createdById: userId }, data: { createdById: null } });

    // 3. Scrub + deactivate the User row. Email must remain unique but de-identified.
    //    Use a valid RFC-5321 local-part (no bracketed marker in the address
    //    itself; the display name keeps the marker).
    await tx.user.update({
      where: { id: userId },
      data: {
        name: PSEUDO_MARKER,
        email: `erased-${userId}@erased.local`,
        initials: null,
        isActive: false,
      },
    });

    // 4. Audit the pseudonymization itself, in the SAME tx as steps 1-3 —
    //    the audit row records WHO erased whom, and commits/rolls back atomically
    //    with the rest of the erasure.
    await audit({
      action: "UserPseudonymized",
      // Lowercase per the ENTITY_TYPE contract — listEntityHistory does an exact,
      // case-sensitive match, so "User" would make this row invisible to a
      // per-user history lookup (same class of bug this PR fixes for rooms).
      entityType: ENTITY_TYPE.user,
      entityId: userId,
      data: { auditRowsAffected, scrubbed: { name: true, email: true, initials: true } },
    });

    return { userId, auditRowsAffected };
  });
}

/**
 * Retention prune. Deletes ActivityLog rows older than `cutoff` via
 * the privileged `prune_activity_log` function. Runs from the daily boot job
 * (retention.boot.server.ts). Idempotent.
 *
 * The prune itself deletes rows with no audit trail of the deletion, which
 * would be an unlogged gap in an otherwise append-only history. So write ONE
 * summary audit row per run (skipped when nothing was deleted, to avoid daily
 * no-op noise). The privileged function sets the transaction-local
 * `jiangtang.audit_bypass` GUC for the rest of the tx, but that only matters for
 * UPDATE/DELETE on ActivityLog — this is a plain INSERT, which the trigger
 * never guards, so it commits normally alongside the prune in the same tx.
 */
export async function pruneActivityLog(cutoff: Date): Promise<number> {
  return txWithAudit(RETENTION_SYSTEM_ACTOR, async (tx, audit) => {
    const [row] =
      (await tx.$queryRaw`SELECT prune_activity_log(${cutoff}::timestamptz) AS deleted`) as Array<{
        deleted: number;
      }>;
    const deleted = Number(row?.deleted ?? 0);
    if (deleted > 0) {
      await audit({
        action: "ActivityLogPruned",
        entityType: "activityLog",
        entityId: "retention",
        data: { deleted, cutoff: cutoff.toISOString() },
      });
    }
    return deleted;
  });
}
