import { db, type Tx } from "~/lib/db.server";
import type { Prisma } from "~/generated/prisma/client";
import type { EntityType } from "~/lib/realtime/events";

/**
 * The mutation funnel. EVERY meaningful change is recorded in the append-only
 * ActivityLog in the SAME transaction as the change, so the audit row and the
 * mutation commit or roll back together.
 *
 *   await txWithAudit(actor, async (tx, audit) => {
 *     const ticket = await tx.ticket.update({ … });
 *     await audit({ action: "TicketResolved", entityType: "ticket", entityId: ticket.id });
 *   });
 *
 * Raw `db.$transaction` in app/domains/ is banned (CI guard) — this is the only
 * sanctioned path.
 */

export interface AuditActor {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  initials?: string | null;
  via?: { kind: "mcp"; tokenId: string; tokenName: string };
}

export interface ActivityInput {
  /** Semantic verb, e.g. "TicketResolved", "EquipmentAllocated", "EventMovedRoom". */
  action: string;
  /**
   * The ONE owned vocabulary. Typed, not `string`: `listEntityHistory`
   * matches this column exactly and case-sensitively, so a wrong casing is not
   * a cosmetic mistake but a row no reader can ever return. A type is the fix
   * that holds: it is checked on every build, whereas a test can be deleted.
   *
   * Writers that bypass `audit()` and call `db.activityLog.create` directly are
   * the ones the type cannot see; those are covered by a scan — see
   * `app/lib/realtime/__tests__/entity-type-vocabulary.test.ts`.
   */
  entityType: EntityType;
  entityId: string;
  /** Optional structured detail (kept PII-light; see docs/GDPR.md). */
  data?: Prisma.InputJsonValue;
  /** Logical time; defaults to now (may be back-dated on import). */
  occurredAt?: Date;
}

function actorSnapshot(actor?: AuditActor | null): Prisma.InputJsonValue | undefined {
  if (!actor) return undefined;
  const snap: Record<string, string> = {};
  if (actor.name) snap.name = actor.name;
  if (actor.email) snap.email = actor.email;
  if (actor.initials) snap.initials = actor.initials;
  if (actor.via) {
    snap.via = `via MCP (${actor.via.tokenName})`;
    snap.tokenId = actor.via.tokenId;
  }
  // An actor with only an `id` (e.g. a system/service actor with no
  // name/email/initials on hand) would otherwise produce an EMPTY snapshot,
  // which Prisma writes as SQL NULL — losing attribution once actorId's
  // referenced User row is later edited/anonymized (GDPR erase). Fall back to
  // the id so at least something identifying survives in the immutable
  // ActivityLog row itself. Normal actors (name/email/initials present) are
  // unaffected — this only fires when ALL of those are absent.
  if (Object.keys(snap).length === 0 && actor.id) snap.id = actor.id;
  return Object.keys(snap).length > 0 ? snap : undefined;
}

/** Write one ActivityLog row on the given transaction. */
export async function writeActivity(
  tx: Tx,
  input: ActivityInput & { actor?: AuditActor | null },
): Promise<void> {
  await tx.activityLog.create({
    data: {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      actorId: input.actor?.id ?? null,
      actorSnapshot: actorSnapshot(input.actor),
      data: input.data,
      occurredAt: input.occurredAt,
    },
  });
}

export type AuditFn = (input: ActivityInput) => Promise<void>;

export interface TxWithAuditOptions {
  /** Max ms the transaction body may run before Prisma aborts it (default ~5s). */
  timeout?: number;
  /** Max ms to wait to acquire a transaction slot before giving up. */
  maxWait?: number;
}

/**
 * Run `fn` in a transaction with a pre-bound `audit` (actor + tx filled in).
 * The transaction — mutation AND audit — commits or rolls back atomically.
 *
 * `opts` is optional and backward-compatible with existing 2-arg call sites;
 * pass a generous `{ timeout, maxWait }` for bulk imports that do many
 * sequential row round-trips inside one transaction (else Prisma's ~5s
 * default aborts with P2028 partway through a large CSV).
 */
export async function txWithAudit<T>(
  actor: AuditActor | null,
  fn: (tx: Tx, audit: AuditFn) => Promise<T>,
  opts?: TxWithAuditOptions,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const audit: AuditFn = (input) => writeActivity(tx as Tx, { ...input, actor });
    return fn(tx as Tx, audit);
  }, opts);
}
