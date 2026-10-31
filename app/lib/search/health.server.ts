/**
 * Search health for the dashboard's „Speicher & Index" card:
 * state + counts over `getIndexStats()` and the AI capability statuses.
 * `note` is rendered verbatim — the card never hard-codes wording.
 */
import { getAi } from "~/lib/ai/registry.server";
import { tr } from "~/i18n/request-locale.server";
import { getIndexStats } from "./indexer.server";

export type SearchHealthState = "lexical" | "semantisch" | "gestört";

export interface SearchHealth {
  state: SearchHealthState;
  note: string;
  chunks: number;
  embedded: number;
  failedJobs: number;
}

export async function getSearchHealth(): Promise<SearchHealth> {
  const stats = await getIndexStats();
  const statuses = getAi().statuses;
  const embedding = statuses.find((s) => s.capability === "embedding");
  const chunks = stats.types.reduce((s, t) => s + t.chunks, 0);
  const embedded = stats.types.reduce((s, t) => s + t.embedded, 0);

  const broken = stats.failedJobs > 0 || statuses.some((s) => s.state === "misconfigured");
  const state: SearchHealthState = broken
    ? "gestört"
    : embedding?.state === "api"
      ? "semantisch"
      : "lexical";

  const note =
    state === "semantisch"
      ? tr("places.err.search.healthSemantic", {
          embedded,
          chunks,
          model: stats.activeModel ?? "",
        })
      : state === "gestört"
        ? stats.latestErrors[0]
          ? tr("places.err.search.healthBrokenLatest", {
              failed: stats.failedJobs,
              error: stats.latestErrors[0],
            })
          : tr("places.err.search.healthBroken", { failed: stats.failedJobs })
        : tr("places.err.search.healthLexical", { chunks });

  return { state, note, chunks, embedded, failedJobs: stats.failedJobs };
}
