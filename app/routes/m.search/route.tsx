import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { hybridSearch } from "~/lib/search/query.server";
import { EmptyState } from "~/components/states/empty-state";
import { Search as SearchIcon } from "lucide-react";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * Mobile search — one box over `hybridSearch`, results tap through to
 * the entity (the hrefs point at the desktop routes; deep mobile detail
 * pages exist only for tasks/tickets, and the links degrade gracefully to
 * the desktop layout inside the same PWA).
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "search.page.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const { results, degraded } = q
    ? await hybridSearch(q, { limit: 15 })
    : { results: [], degraded: [] };
  return { q, results, degraded };
}

export default function MobileSearch({ loaderData }: Route.ComponentProps) {
  const { q, results, degraded } = loaderData;
  const t = useT();
  return (
    <div className="flex flex-col">
      <div className="border-border border-b px-4 py-3">
        <h1 className="font-mono text-lg">{t("nav.search")}</h1>
        <Form method="get" className="mt-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={t("mobile.search.placeholder")}
            className="border-border bg-background min-h-11 w-full rounded-sm border px-3 text-base"
          />
        </Form>
      </div>

      <ul className="divide-border divide-y">
        {results.map((r) => (
          <li key={`${r.sourceType}:${r.sourceId}`}>
            {r.href ? (
              <Link to={r.href} className="active:bg-accent block px-4 py-3">
                <div className="truncate text-base">{r.title}</div>
                <p
                  className="text-muted-foreground line-clamp-2 text-xs [&_mark]:bg-transparent [&_mark]:font-semibold [&_mark]:text-foreground"
                  // Hybrid-search snippets contain only <mark> tags from our own query.
                  dangerouslySetInnerHTML={{ __html: r.snippetHtml }}
                />
              </Link>
            ) : (
              <div className="px-4 py-3">
                <div className="text-muted-foreground truncate text-base">{r.title}</div>
              </div>
            )}
          </li>
        ))}
        {q && results.length === 0 ? (
          <li className="p-4">
            <EmptyState
              icon={SearchIcon}
              title={t("mobile.search.noHits", { q })}
              className="border-0"
            />
          </li>
        ) : null}
      </ul>
      {degraded.length > 0 ? (
        <p className="text-muted-foreground px-4 py-2 font-mono text-xs">
          {t("mobile.search.degraded", { sources: degraded.join(", ") })}
        </p>
      ) : null}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
