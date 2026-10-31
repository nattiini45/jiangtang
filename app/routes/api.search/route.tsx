import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { resolveLocale } from "~/i18n/locale.server";
import { runSearch } from "./search.server";

/**
 * Resource route backing the global command palette (Ctrl/Cmd-K). The search
 * body lives in ./search.server.ts; this module deliberately exports ONLY the
 * loader (plus erased types) so no server code can leak into the client bundle.
 *
 * Read-only, auth-gated (same surface as every desktop page).
 */

export type { SearchResult, SearchResultType } from "./search.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request); // same auth surface as the desktop pages it searches
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const results = await runSearch(q, resolveLocale(request));
    return Response.json({ results });
  } catch (e) {
    throw toErrorResponse(e);
  }
}
