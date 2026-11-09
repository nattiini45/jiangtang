import { Form, Link } from "react-router";
import type { Notification, NotificationType } from "~/generated/prisma/client";
import { entityHref } from "~/lib/entity-links";
import { berlinDateInput } from "~/lib/format-date";
import { berlinLocalString } from "~/lib/berlin-days";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/states/empty-state";
import { Bell } from "lucide-react";
import { useLocale, useT } from "~/i18n/use-t";
import type { MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { formatDate, formatDateTime } from "~/i18n/format";
import { cn } from "~/lib/utils";

/**
 * The shared inbox list (desktop `/notifications` and `/m/notifications`).
 * Each row links to its entity via `entityHref` when one exists and carries a
 * mark-as-read form; unread rows render with a dot.
 */
/**
 * The label params for one notification row. Payload keys map to template
 * placeholders: `dueAt`/`warrantyExpiresAt` are ISO instants that render as
 * Berlin dates under the shared `{date}` placeholder.
 */
export function notificationLabelParams(
  type: NotificationType,
  data: unknown,
  locale?: Locale,
): Record<string, string> {
  const raw = (data ?? {}) as Record<string, unknown>;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") continue;
    if (/^(dueAt|warrantyExpiresAt)$/.test(k) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      params.date = locale ? formatDate(locale, v) : berlinDateInput(v);
    } else {
      params[k] = v;
    }
  }
  if (type === "BOOKING_CONFLICT" && !params.detail) {
    const conflicts = Array.isArray(raw.conflicts) ? raw.conflicts : [];
    const first = conflicts[0] as { eventTitle?: string } | undefined;
    params.detail = first?.eventTitle ?? (typeof raw.roomId === "string" ? raw.roomId : "");
  }
  return params;
}

export function NotificationList({
  notifications,
  mobile = false,
}: {
  notifications: Notification[];
  mobile?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
      {notifications.map((n) => {
        const params = notificationLabelParams(n.type, n.data, mobile ? locale : undefined);
        const label = t(`notifications.type.${n.type}` as MessageKey, params);
        const href =
          n.entityType && n.entityId ? entityHref(n.entityType, { id: n.entityId }) : null;
        // The entity link and the mark-as-read form are SIBLINGS: nesting the
        // form inside the link would bubble the button's click into a navigation.
        const body = (
          <span className={cn("min-w-0 flex-1", mobile && "basis-full")}>
            <span className="flex items-center gap-2">
              {n.readAt ? null : (
                <span
                  className="bg-primary inline-block size-2 shrink-0 rounded-full"
                  aria-hidden
                />
              )}
              <span className={cn("text-sm font-semibold", !mobile && "truncate")}>{label}</span>
            </span>
            <p className={cn("text-muted-foreground nums text-xs", !mobile && "truncate")}>
              {mobile
                ? formatDateTime(locale, n.createdAt)
                : berlinLocalString(n.createdAt).slice(0, 16).replace("T", " ")}
            </p>
          </span>
        );
        const markRead = (
          <Form method="post" className={cn("shrink-0", mobile && "ml-auto")}>
            <input type="hidden" name="_action" value="mark-read" />
            <input type="hidden" name="id" value={n.id} />
            {n.readAt ? null : (
              <Button
                type="submit"
                variant="ghost"
                size={mobile ? "default" : "compact"}
                title={t("notifications.markRead")}
              >
                {t("notifications.markRead")}
              </Button>
            )}
          </Form>
        );
        return (
          <li
            key={n.id}
            className={cn("flex min-h-12 items-center gap-3 px-3 py-2", mobile && "flex-wrap")}
          >
            {href ? (
              <Link
                to={href}
                className={cn(
                  "active:bg-selected flex min-w-0 flex-1 items-center transition-colors duration-80",
                  mobile && "min-h-11 basis-full",
                )}
              >
                {body}
              </Link>
            ) : (
              body
            )}
            {markRead}
          </li>
        );
      })}
      {notifications.length === 0 ? (
        <li>
          <EmptyState
            icon={Bell}
            title={t("notifications.empty")}
            hint={mobile ? t("mobile.notifications.emptyHint") : undefined}
          />
        </li>
      ) : null}
    </ul>
  );
}

export type { NotificationType };
