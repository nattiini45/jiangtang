import type { Notification } from "~/generated/prisma/client";
import { canQueueMail, queueMail } from "~/domains/mail/mail.server";
import { t } from "~/i18n";
import { formatDate } from "~/i18n/format";
import { workspaceLocale } from "~/i18n/locale.server";
import { readConfig } from "~/lib/config.server";
import type { Tx } from "~/lib/db.server";
import { logger } from "~/lib/observability/logger.server";
import { entityHref } from "~/lib/entity-links";

export async function queueNotificationEmails(tx: Tx, rows: Notification[]) {
  if (rows.length === 0) return;
  const base = URL.parse(readConfig("BETTER_AUTH_URL") ?? "");
  if (
    !base ||
    (base.protocol !== "https:" && base.protocol !== "http:") ||
    !(await canQueueMail(tx))
  ) {
    return;
  }
  const users = await tx.user.findMany({
    where: {
      id: { in: [...new Set(rows.map((row) => row.userId))] },
      isActive: true,
      emailVerified: true,
    },
    select: { id: true, email: true, notificationEmailOptOuts: true },
  });
  const recipients = new Map(users.map((user) => [user.id, user]));
  const locale = workspaceLocale();
  const groups = new Map<
    string,
    {
      recipient: string;
      userId: string;
      type: Notification["type"];
      items: { title: string; text: string }[];
    }
  >();
  for (const row of rows) {
    const user = recipients.get(row.userId);
    if (
      !user ||
      user.notificationEmailOptOuts.includes(row.type) ||
      !row.entityType ||
      !row.entityId
    )
      continue;
    const href = entityHref(row.entityType, { id: encodeURIComponent(row.entityId) });
    const params =
      row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
    const title = row.type === "WARRANTY_EXPIRING" ? params.name : params.title;
    if (!href || typeof title !== "string") continue;
    const instant = params.dueAt ?? params.warrantyExpiresAt;
    const date =
      typeof instant === "string" && Number.isFinite(Date.parse(instant))
        ? formatDate(locale, instant)
        : "";
    const label = t(locale, `notifications.type.${row.type}`, {
      title,
      name: title,
      detail: title,
      date,
    });
    const digest = row.type === "TASK_DUE_SOON" || row.type === "WARRANTY_EXPIRING";
    const key = digest ? `${user.id}:${row.type}` : row.id;
    const group = groups.get(key) ?? {
      recipient: user.email,
      userId: user.id,
      type: row.type,
      items: [],
    };
    group.items.push({ title, text: `${label}\n${new URL(href, base).href}` });
    groups.set(key, group);
  }
  if (groups.size === 0) return;
  await tx.$executeRaw`SAVEPOINT notification_email`;
  try {
    for (const { recipient, userId, type, items } of groups.values()) {
      const title = items[0]!.title;
      const item =
        items.length === 1
          ? title
          : t(locale, "notifications.email.more", { title, count: items.length - 1 });
      await queueMail(tx, {
        kind: `notification:${type}`,
        recipient,
        verifiedRecipientId: userId,
        subject: t(locale, `notifications.email.subject.${type}`, { item }),
        text: items.map((entry) => entry.text).join("\n\n"),
      });
    }
  } catch {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT notification_email`;
    logger.error("[notifications] Could not queue email; keeping inbox notifications");
  }
  await tx.$executeRaw`RELEASE SAVEPOINT notification_email`;
}
