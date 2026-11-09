import { createHash, randomBytes } from "node:crypto";
import { db } from "~/lib/db.server";
import { adminTwoFactorRequired } from "~/lib/auth.server";
import { txWithAudit } from "~/lib/audit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { ENTITY_TYPE } from "~/domains/tickets/tickets.history.server";
import {
  tokenCreateSchema,
  type TokenActor,
  type TokenCreateInput,
} from "~/domains/api-tokens/api-tokens.schema";

const TOKEN_METADATA_SELECT = {
  id: true,
  userId: true,
  name: true,
  scope: true,
  createdAt: true,
  revokedAt: true,
  lastUsedAt: true,
} as const;

export function canManageAllPersonalAccessTokens(actor: TokenActor): boolean {
  return actor.role === "ADMIN" && (!adminTwoFactorRequired() || actor.twoFactorEnabled === true);
}

export async function listPersonalAccessTokens(actor: TokenActor, options: { all?: boolean } = {}) {
  if (options.all && !canManageAllPersonalAccessTokens(actor)) {
    throw new Response(null, { status: 403 });
  }
  const records = await db.personalAccessToken.findMany({
    where: options.all ? {} : { userId: actor.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { ...TOKEN_METADATA_SELECT, user: { select: { id: true, name: true } } },
  });
  return records.map(({ user, ...record }) => ({ ...record, owner: user }));
}

export async function authenticatePersonalAccessToken(raw: string) {
  if (!/^jtg_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const record = await db.personalAccessToken.findUnique({
    where: { tokenHash },
    select: { id: true, name: true, scope: true, revokedAt: true, user: true },
  });
  if (!record || record.revokedAt || !record.user.isActive) return null;
  const requireTwoFactor = adminTwoFactorRequired();
  if (requireTwoFactor && record.user.role === "ADMIN" && !record.user.twoFactorEnabled) {
    return null;
  }
  const updated = await db.personalAccessToken.updateMany({
    where: {
      id: record.id,
      revokedAt: null,
      user: {
        isActive: true,
        ...(requireTwoFactor ? { OR: [{ role: "MEMBER" }, { twoFactorEnabled: true }] } : {}),
      },
    },
    data: { lastUsedAt: new Date() },
  });
  if (updated.count !== 1) return null;
  return {
    token: { id: record.id, name: record.name, scope: record.scope },
    user: record.user,
  };
}

export async function createPersonalAccessToken(actor: TokenActor, input: TokenCreateInput) {
  const parsed = tokenCreateSchema.parse(input);
  const token = `jtg_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const record = await txWithAudit(actor, async (tx, audit) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} FOR UPDATE`;
    const owner = await tx.user.findUnique({ where: { id: actor.id }, select: { isActive: true } });
    if (!owner) throw new NotFoundError();
    if (!owner.isActive) throw new ValidationError({}, [tr("account.tokens.inactive")]);
    const created = await tx.personalAccessToken.create({
      data: { userId: actor.id, ...parsed, tokenHash },
      select: TOKEN_METADATA_SELECT,
    });
    await audit({
      action: "PersonalAccessTokenCreated",
      entityType: ENTITY_TYPE.user,
      entityId: actor.id,
      data: { tokenId: created.id, name: created.name, scope: created.scope },
    });
    return created;
  });
  await emitChange({ entityType: ENTITY_TYPE.user, id: actor.id, op: "updated" });
  return { token, record };
}

export async function revokePersonalAccessToken(actor: TokenActor, id: string) {
  const record = await txWithAudit(actor, async (tx, audit) => {
    const existing = await tx.personalAccessToken.findUnique({
      where: { id },
      select: TOKEN_METADATA_SELECT,
    });
    if (!existing) throw new NotFoundError();
    if (existing.userId !== actor.id && !canManageAllPersonalAccessTokens(actor)) {
      throw new Response(null, { status: 403 });
    }
    if (existing.revokedAt) return existing;
    const revokedAt = new Date();
    const updated = await tx.personalAccessToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt },
    });
    if (updated.count === 1) {
      await audit({
        action: "PersonalAccessTokenRevoked",
        entityType: ENTITY_TYPE.user,
        entityId: existing.userId,
        data: { tokenId: id, name: existing.name, scope: existing.scope },
      });
    }
    return tx.personalAccessToken.findUniqueOrThrow({
      where: { id },
      select: TOKEN_METADATA_SELECT,
    });
  });
  await emitChange({ entityType: ENTITY_TYPE.user, id: record.userId, op: "updated" });
  return record;
}
