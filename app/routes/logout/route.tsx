import { redirect } from "react-router";
import type { Route } from "./+types/route";
import { auth } from "~/lib/auth.server";

export async function action({ request }: Route.ActionArgs) {
  const response = await auth.api.signOut({ headers: request.headers, asResponse: true });
  const headers = new Headers();
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) headers.append("set-cookie", setCookie);
  return redirect("/login", { headers });
}

export async function loader() {
  return redirect("/login");
}
