import { useEffect } from "react";
import { Outlet, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { maybeRegisterServiceWorker } from "~/lib/pwa/register-sw";
import { MobileShell } from "~/components/mobile/mobile-shell";

// Mobile PWA surface, served under /m with its own design. Auth-guarded by
// default: the whole /m tree requires a signed-in user — requireUser
// redirects anonymous requests to /login (with ?next= so they return here).
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  return { user: { name: user.name, initials: user.initials, role: user.role } };
}

export default function MobileLayout() {
  // Register the service worker once on the mobile surface (scoped to /m).
  useEffect(() => {
    maybeRegisterServiceWorker();
  }, []);

  const data = useRouteLoaderData<typeof loader>("routes/m");
  return (
    <MobileShell user={data?.user ?? { name: "" }}>
      <Outlet />
    </MobileShell>
  );
}
