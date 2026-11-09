import { Form, Link } from "react-router";
import { ViewSwitch } from "~/components/layout/view-switch";
import { hasMobileEquivalent, viewPath } from "~/lib/view.server";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { hybridSearch } from "~/lib/search/query.server";
import { EmptyState } from "~/components/states/empty-state";
import { Input } from "~/components/ui/input";
import { Search as SearchIcon } from "lucide-react";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "search.page.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const { results, degraded } = q
    ? await hybridSearch(q, { limit: 15 })
    : { results: [], degraded: [] };
  return {
    q,
    results: results.map((result) => ({
      ...result,
      mobileHref:
        result.href && hasMobileEquivalent(result.href) ? viewPath(result.href, "mobile") : null,
    })),
    degraded,
  };
}

export default function MobileSearch({ loaderData }: Route.ComponentProps) {
  const { q, results, degraded } = loaderData;
  const t = useT();
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <h1 className="text-lg font-semibold">{t("nav.search")}</h1>
      <Form method="get">
        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={t("mobile.search.placeholder")}
          className="min-h-11"
        />
      </Form>

      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg empty:hidden">
        {results.map((r) => (
          <li key={`${r.sourceType}:${r.sourceId}`}>
            {r.mobileHref ? (
              <Link
                to={r.mobileHref}
                className="active:bg-selected block min-h-12 px-3 py-2 transition-colors duration-80"
              >
                <div className="truncate text-sm font-semibold">{r.title}</div>
                <p
                  className="text-muted-foreground line-clamp-2 text-xs [&_mark]:bg-transparent [&_mark]:font-semibold [&_mark]:text-foreground"
                  // Hybrid-search snippets contain only <mark> tags from our own query.
                  dangerouslySetInnerHTML={{ __html: r.snippetHtml }}
                />
              </Link>
            ) : r.href ? (
              <ViewSwitch
                view="desktop"
                desktopLabel
                next={r.href}
                className="active:bg-selected block min-h-12 w-full px-3 py-2 text-left transition-colors duration-80"
              >
                <span className="block truncate text-sm font-semibold">{r.title}</span>
                <span
                  className="text-muted-foreground line-clamp-2 text-xs [&_mark]:bg-transparent [&_mark]:font-semibold [&_mark]:text-foreground"
                  dangerouslySetInnerHTML={{ __html: r.snippetHtml }}
                />
              </ViewSwitch>
            ) : (
              <div className="px-3 py-3">
                <div className="text-muted-foreground truncate text-sm">{r.title}</div>
              </div>
            )}
          </li>
        ))}
        {q && results.length === 0 ? (
          <li>
            <EmptyState icon={SearchIcon} title={t("mobile.search.noHits", { q })} />
          </li>
        ) : null}
      </ul>
      {degraded.length > 0 ? (
        <p className="bg-status-warning/15 rounded-md px-3 py-2 text-xs">
          {t("mobile.search.degraded", { sources: degraded.join(", ") })}
        </p>
      ) : null}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
