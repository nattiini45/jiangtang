import { Form } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { listNotifications } from "~/domains/notifications/notifications.queries.server";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "~/domains/notifications/notifications.mutations.server";
import { NotificationList } from "~/components/notifications/notification-list";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "notifications.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const notifications = await listNotifications(user.id, { limit: 100 });
  return { notifications };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  try {
    if (intent === "mark-read") {
      const id = String(form.get("id") ?? "");
      if (id) await markNotificationRead(actor, id);
      return { ok: true as const };
    }
    if (intent === "mark-all") {
      await markAllNotificationsRead(actor);
      return { ok: true as const };
    }
    return { ok: false as const };
  } catch (e) {
    throw toErrorResponse(e);
  }
}

export default function NotificationsIndex({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const { notifications } = loaderData;
  const unread = notifications.filter((n) => !n.readAt).length;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("notifications.title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {unread > 0 ? t("notifications.unread", { count: unread }) : t("notifications.allRead")}
          </p>
        </div>
        {unread > 0 ? (
          <Form method="post">
            <input type="hidden" name="_action" value="mark-all" />
            <Button type="submit" variant="tertiary">
              {t("notifications.markAll")}
            </Button>
          </Form>
        ) : null}
      </div>
      <NotificationList notifications={notifications} />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
