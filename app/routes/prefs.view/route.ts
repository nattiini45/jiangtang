import { data, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { authLanding, setViewCookie, viewPath } from "~/lib/view.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return redirect(authLanding(request));
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const form = await request.formData();
  const view = form.get("view");
  if (view !== "desktop" && view !== "mobile") throw data(null, { status: 400 });
  const next = form.get("next");
  return redirect(viewPath(typeof next === "string" ? next : null, view), {
    headers: { "Set-Cookie": setViewCookie(view), "Cache-Control": "private, no-store" },
  });
}
