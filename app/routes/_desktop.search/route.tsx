import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getAi } from "~/lib/ai/registry.server";
import { hybridSearch } from "~/lib/search/query.server";
import { SOURCE_TYPES } from "~/lib/search/source-types";
import { armLabel, searchAnchor, sourceTypeLabel } from "~/lib/search/labels";
import { AskBox } from "~/components/search/ask-box";
import { EmptyState } from "~/components/states/empty-state";
import { Search as SearchIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/search` — the hybrid results page. One box, every source type behind
 * it: lexical (`and`/`or`), trigram (`fuzzy`) and — when an embedding provider
 * is configured — the dense arm. Each hit carries its citation anchor and the
 * arms that found the cited chunk. `degraded` names a failed arm; a missing
 * embedding provider shows the „nur Stichwortsuche" notice — never an error.
 */

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "search.page.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const types = url.searchParams
    .getAll("type")
    .map((type) => type.trim().toUpperCase())
    .filter((type): type is (typeof SOURCE_TYPES)[number] =>
      (SOURCE_TYPES as readonly string[]).includes(type),
    );
  const { results, degraded } = await hybridSearch(q, {
    limit: 20,
    sourceTypes: types.length ? types : undefined,
  });
  return {
    q,
    types,
    results,
    degraded,
    semantic: getAi().embedding != null,
  };
}

export default function SearchPage({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { q, types, results, degraded, semantic } = loaderData;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-mono text-xl">{t("nav.search")}</h1>
        <p className="text-muted-foreground text-sm">{t("search.page.subtitle")}</p>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={t("search.page.placeholder")}
          aria-label={t("search.page.queryAria")}
          autoFocus
          className="border-border bg-background focus:border-ring min-w-[16rem] flex-1 rounded-sm border px-3 py-1.5 font-mono text-sm outline-none"
        />
        <Button type="submit" variant="outline" size="sm">
          {t("search.page.submit")}
        </Button>
      </Form>

      <Form method="get" className="flex flex-wrap items-center gap-1.5">
        <input type="hidden" name="q" value={q} />
        {SOURCE_TYPES.map((type) => (
          <label
            key={type}
            className={cn(
              "border-border text-muted-foreground inline-flex cursor-pointer items-center rounded-sm border px-2 py-1 font-mono text-xs",
              "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-foreground",
            )}
          >
            <input
              type="checkbox"
              name="type"
              value={type}
              defaultChecked={types.includes(type)}
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
              className="sr-only"
            />
            {sourceTypeLabel(locale, type)}
          </label>
        ))}
      </Form>

      <AskBox />

      {degraded.length > 0 ? (
        <p className="border-status-warning/40 bg-status-warning/10 text-status-warning rounded-sm border px-3 py-2 text-sm">
          {t("search.page.degraded", { arms: degraded.join(", ") })}
        </p>
      ) : null}
      {!semantic ? (
        <p className="text-muted-foreground rounded-sm border border-dashed px-3 py-2 text-sm">
          {t("search.page.noSemantic")}
        </p>
      ) : null}

      {q.trim() && results.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title={t("search.page.noResults", { q })}
          hint={t("search.page.noResultsHint")}
        />
      ) : null}

      <ul className="divide-border divide-y">
        {results.map((r) => {
          const arms = [...new Set(r.arms.map((a) => armLabel(locale, a)))];
          return (
            <li key={`${r.sourceType}:${r.sourceId}:${r.ordinal}`} className="px-1 py-3">
              <div className="flex items-baseline gap-2">
                <span className="border-border bg-secondary text-secondary-foreground inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 text-xs">
                  {sourceTypeLabel(locale, r.sourceType)}
                </span>
                {r.href ? (
                  <Link to={r.href} className="truncate font-medium hover:underline">
                    {r.title}
                  </Link>
                ) : (
                  <span className="text-muted-foreground truncate font-medium">{r.title}</span>
                )}
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
                  {searchAnchor(r.sourceType, r.sourceId, r.ordinal)}
                </span>
              </div>
              <p
                className="text-muted-foreground mt-1 pl-1 text-sm [&_mark]:bg-status-warning/25 [&_mark]:text-foreground [&_mark]:rounded-xs [&_mark]:px-0.5"
                dangerouslySetInnerHTML={{ __html: r.snippetHtml }}
              />
              <p className="text-muted-foreground mt-0.5 pl-1 font-mono text-xs">
                {arms.join(" · ")}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
