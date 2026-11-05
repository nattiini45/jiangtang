import { useEffect } from "react";
import { Outlet, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { maybeRegisterServiceWorker } from "~/lib/pwa/register-sw";
import { MobileShell } from "~/components/mobile/mobile-shell";

// Mobile PWA surface, served under /m with its own design. requireUser redirects
// anonymous requests to /login (with ?next= so they return here). Child loaders and
// actions check sign-in themselves too, because a single-fetch request can run a
// child loader without this one.
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  return { user: { id: user.id, name: user.name, initials: user.initials, role: user.role } };
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
