import { Outlet } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getDensity, getTheme } from "~/lib/theme.server";
import { getRunningEntry } from "~/domains/time/time.queries.server";
import { unreadNotificationCount } from "~/domains/notifications/notifications.queries.server";
import { AppShell } from "~/components/layout/app-shell";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

// Desktop surface — pathless layout. requireUser redirects anonymous users to /login.
// Every child loader and action calls requireUser itself as well: a single-fetch
// `.data` request with `?_routes=<child id>` runs only that child's loader and never
// reaches this one (test/routes/route-auth-guard.test.ts enforces it).
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  // The header's running-timer indicator — one indexed lookup per load.
  const running = await getRunningEntry(user);
  // The header bell's unread badge — same deal.
  const unreadNotifications = await unreadNotificationCount(user.id);
  return {
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      initials: user.initials,
    },
    theme: getTheme(request),
    density: getDensity(request),
    unreadNotifications,
    runningTimer: running
      ? {
          id: running.id,
          startsAt: running.startsAt.toISOString(),
          taskTitle: running.task?.title ?? null,
        }
      : null,
  };
}

export default function DesktopLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AppShell
      user={loaderData.user}
      theme={loaderData.theme}
      density={loaderData.density}
      runningTimer={loaderData.runningTimer}
      unreadNotifications={loaderData.unreadNotifications}
    >
      <Outlet />
    </AppShell>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
