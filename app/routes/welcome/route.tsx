import { Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { getOptionalUser } from "~/lib/auth.server";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

/**
 * `/welcome` — the public landing page for signed-out visitors. Deliberately
 * outside the `_desktop` layout: the layout's `requireUser` would bounce
 * anonymous visitors to `/login` before this page could render, so this route
 * is on the guard test's PUBLIC list and checks the session itself — signed-in
 * users are redirected to the dashboard. It reads nothing private.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "landing.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getOptionalUser(request);
  if (user) throw redirect("/");
  return {};
}

const FEATURES = [
  "landing.feature.rooms",
  "landing.feature.inventory",
  "landing.feature.events",
  "landing.feature.work",
  "landing.feature.tickets",
  "landing.feature.search",
] as const;

export default function Welcome() {
  const t = useT();
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="bg-foreground text-background flex size-8 items-center justify-center rounded-md text-base font-bold"
          >
            J
          </span>
          <span className="text-xl font-bold">Jiangtang</span>
        </div>
        <h1 className="mt-6 text-2xl font-bold text-balance">{t("landing.hero.title")}</h1>
        <p className="text-muted-foreground mt-2 text-sm text-balance">
          {t("landing.hero.subtitle")}
        </p>

        <h2 className="mt-6 text-sm font-semibold">{t("landing.features.title")}</h2>
        <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-5 text-sm">
          {FEATURES.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>

        <p className="text-muted-foreground mt-6 text-xs">{t("landing.selfhosted")}</p>
        <p className="text-muted-foreground mt-1 text-xs">{t("landing.footer.docs")}</p>

        <Button asChild className="mt-6 w-full">
          <Link to="/login">{t("landing.cta.signIn")}</Link>
        </Button>
      </div>
    </main>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
