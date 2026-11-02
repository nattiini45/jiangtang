import { useFetcher } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { getAi } from "~/lib/ai/registry.server";
import {
  getIndexStats,
  embedPending,
  reconcileAll,
  listFailedIndexJobs,
  clearEmbeddingModels,
} from "~/lib/search/indexer.server";
import { logger } from "~/lib/observability/logger.server";
import { sourceTypeLabel } from "~/lib/search/labels";
import { t, type MessageKey } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { resolveLocale } from "~/i18n/locale.server";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/admin/index` — search-index health: provider states, the active
 * embedding model, per-source-type counts and the retry ledger. „Abgleich
 * starten" kicks reconcile + embed in the background; „Embeddings neu
 * berechnen" clears every `embeddingModel` so the worker re-embeds the corpus
 * against the active provider (the dense arm ignores stale models meanwhile).
 */

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "admin.index.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  const stats = await getIndexStats();
  const jobs = await listFailedIndexJobs(10);
  return { statuses: getAi().statuses, stats, jobs };
}

export async function action({ request }: Route.ActionArgs) {
  await requireRole(request, "ADMIN");
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "reembed") {
    // Pending = `embeddingModel <> active` — clearing the stamp is enough.
    await clearEmbeddingModels();
    kick();
    return { ok: true };
  }
  if (intent === "reconcile") {
    kick();
    return { ok: true };
  }
  return { error: t(locale, "err.unknownAction") };
}

/** Fire-and-forget: the sweep is minutes-slow on a big corpus — don't hold the POST. */
function kick() {
  void (async () => {
    try {
      await reconcileAll();
      for (let i = 0; i < 20; i++) {
        if ((await embedPending({ limit: 256 })).embedded === 0) break;
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "[search] manual sweep failed");
    }
  })();
}

const STATE_LABEL: Record<string, MessageKey> = {
  api: "admin.index.state.api",
  none: "admin.index.state.none",
  misconfigured: "admin.index.state.misconfigured",
};

const CAPABILITY_LABEL: Record<string, MessageKey> = {
  embedding: "admin.index.capability.embedding",
  reranker: "admin.index.capability.reranker",
  generation: "admin.index.capability.generation",
};

export default function AdminIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { statuses, stats, jobs } = loaderData;
  const fetcher = useFetcher<typeof action>();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("nav.searchIndex")}</h1>
          <p className="text-muted-foreground text-sm">{t("admin.index.subtitle")}</p>
        </div>
        <fetcher.Form method="post" className="flex gap-2">
          <Button type="submit" name="intent" value="reconcile" variant="secondary" size="compact">
            {t("admin.index.reconcile")}
          </Button>
          <Button type="submit" name="intent" value="reembed" variant="secondary" size="compact">
            {t("admin.index.reembed")}
          </Button>
        </fetcher.Form>
      </div>

      <section className="bg-card shadow-surface-2 rounded-lg">
        <h2 className="border-border border-b px-4 py-3 text-base font-semibold">
          {t("admin.index.providers")}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 py-3 text-sm">
          {statuses.map((s) => (
            <div key={s.capability} className="contents">
              <dt className="text-muted-foreground">
                {CAPABILITY_LABEL[s.capability] ? t(CAPABILITY_LABEL[s.capability]) : s.capability}
              </dt>
              <dd>
                {STATE_LABEL[s.state] ? t(STATE_LABEL[s.state]) : s.state}
                {s.model ? ` · ${s.model}` : ""}
                {s.host ? ` · ${s.host}` : ""}
                {s.detail ? ` — ${s.detail}` : ""}
              </dd>
            </div>
          ))}
          <div className="contents">
            <dt className="text-muted-foreground">{t("admin.index.activeModel")}</dt>
            <dd className="font-mono text-xs">{stats.activeModel ?? "—"}</dd>
          </div>
          <div className="contents">
            <dt className="text-muted-foreground">{t("admin.index.jobs")}</dt>
            <dd className="nums">
              {t("admin.index.jobsValue", { pending: stats.pendingJobs, failed: stats.failedJobs })}
            </dd>
          </div>
        </dl>
      </section>

      <section className="bg-card shadow-surface-2 rounded-lg">
        <h2 className="border-border border-b px-4 py-3 text-base font-semibold">
          {t("admin.index.coverage")}
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-left text-xs">
              <th className="px-4 py-1.5 font-semibold">{t("admin.index.col.type")}</th>
              <th className="px-4 py-1.5 font-semibold">{t("admin.index.col.sources")}</th>
              <th className="px-4 py-1.5 font-semibold">{t("admin.index.col.chunks")}</th>
              <th className="px-4 py-1.5 font-semibold">{t("admin.index.col.embedded")}</th>
            </tr>
          </thead>
          <tbody>
            {stats.types.map((row) => (
              <tr key={row.sourceType} className="border-border border-b last:border-b-0">
                <td className="px-4 py-1.5">{sourceTypeLabel(locale, row.sourceType)}</td>
                <td className="nums px-4 py-1.5">{row.sources}</td>
                <td className="nums px-4 py-1.5">{row.chunks}</td>
                <td className="nums px-4 py-1.5">{row.embedded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {jobs.length > 0 ? (
        <section className="bg-card shadow-surface-2 rounded-lg">
          <h2 className="border-border border-b px-4 py-3 text-base font-semibold">
            {t("admin.index.failedJobs")}
          </h2>
          <ul className="divide-border divide-y text-sm">
            {jobs.map((j) => (
              <li key={`${j.sourceType}:${j.sourceId}`} className="px-4 py-2">
                <span className="font-mono text-xs">
                  {j.sourceType}·{j.sourceId.slice(0, 8)}
                </span>{" "}
                <span className="text-muted-foreground nums text-xs">
                  · {t("admin.index.attempt", { count: j.attempts })}
                </span>
                <p className="text-muted-foreground truncate text-xs">{j.lastError}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
