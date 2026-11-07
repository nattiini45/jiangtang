import type { notificationsDe } from "../de/notifications";

export const notificationsEn = {
  "notifications.meta.list": "Notifications · Jiangtang",
  "notifications.title": "Notifications",
  "notifications.subtitle": "Assignments, due dates, booking conflicts, warranty expiries.",
  "notifications.empty": "Nothing here — you are all caught up.",
  "notifications.markAll": "Mark all as read",
  "notifications.markRead": "Mark as read",
  "notifications.unread": "{count} unread",
  "notifications.allRead": "All read",
  "notifications.type.TASK_ASSIGNED": "Assigned to “{title}”",
  "notifications.type.TASK_DUE_SOON": "“{title}” is due on {date}",
  "notifications.type.BOOKING_CONFLICT": "Booking conflict: {detail}",
  "notifications.type.WARRANTY_EXPIRING": "Warranty of “{name}” expires on {date}",
  "shell.notifications": "Notifications",
} satisfies Record<keyof typeof notificationsDe, string>;
