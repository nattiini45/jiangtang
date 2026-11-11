import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  return redirect("/admin/search-index");
}
