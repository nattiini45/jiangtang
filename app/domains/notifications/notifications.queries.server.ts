import { db } from "~/lib/db.server";

/**
 * Inbox reads. `listNotifications` is newest-first; `unreadCount` backs the
 * header bell and is one indexed count per shell load.
 */
export async function listNotifications(
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
) {
  return db.notification.findMany({
    where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 100,
  });
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } });
}

/** Dedup probe for the sweep jobs: has this user already been notified about
 *  this entity for this type? */
export async function hasNotification(
  userId: string,
  type: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const row = await db.notification.findFirst({
    where: { userId, type: type as never, entityType, entityId },
    select: { id: true },
  });
  return row !== null;
}
