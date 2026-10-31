import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { exportWorkspace } from "~/domains/transfer/export.server";
import { berlinDateKey } from "~/lib/berlin-days";

/**
 * `GET /export/workspace.json` — the whole workspace as a versioned
 * `jiangtang-workspace` JSON document, auth-guarded like every other surface.
 * The filename carries the Berlin export day.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const data = await exportWorkspace();
  const day = berlinDateKey(new Date());
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="jiangtang-workspace-${day}.json"`,
    },
  });
}
