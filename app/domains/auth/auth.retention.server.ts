import { db } from "~/lib/db.server";

export async function pruneExpiredSessions(now: Date): Promise<number> {
  return (await db.session.deleteMany({ where: { expiresAt: { lte: now } } })).count;
}

export async function pruneExpiredVerifications(now: Date): Promise<number> {
  return (await db.verification.deleteMany({ where: { expiresAt: { lte: now } } })).count;
}
