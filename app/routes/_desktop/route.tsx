import { Outlet } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getDensity, getTheme } from "~/lib/theme.server";
import { getRunningEntry } from "~/domains/time/time.queries.server";
import { AppShell } from "~/components/layout/app-shell";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

// Desktop surface — pathless layout. The whole desktop tree is auth-guarded here
// (requireUser redirects anonymous users to /login). Feature tracks add routes as
// `app/routes/_desktop.<feature>/`.
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  // The header's running-timer indicator — one indexed lookup per load.
  const running = await getRunningEntry(user.id);
  return {
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      initials: user.initials,
    },
    theme: getTheme(request),
    density: getDensity(request),
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
    >
      <Outlet />
    </AppShell>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
