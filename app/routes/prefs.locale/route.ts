import { data, redirect } from "react-router";
import type { Route } from "./+types/route";
import { setLocaleCookie } from "~/i18n/locale.server";
import { isLocale } from "~/i18n/locales";
import { sanitizeNext } from "~/lib/auth.server";

/**
 * Language switch: POST `locale=en|de` (+ optional `next` local path). Works
 * without JavaScript (a plain `<form method="post">`); a `useFetcher` submit
 * gets the same redirect and revalidates, so the page re-renders in the new
 * language. Public on purpose — the login page needs it too. The cookie is
 * `SameSite=Lax` and only ever carries one of two enum values, so no CSRF
 * token is needed.
 */

export function loader() {
  return redirect("/");
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const locale = form.get("locale");
  if (!isLocale(locale)) {
    throw data("Unsupported locale", { status: 400 });
  }
  const next = form.get("next");
  return redirect(sanitizeNext(typeof next === "string" ? next : null), {
    headers: { "Set-Cookie": setLocaleCookie(locale) },
  });
}
