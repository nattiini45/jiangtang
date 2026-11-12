import { requireUser } from "~/lib/auth.server";
import { catalogModelOptions } from "~/domains/catalog/catalog.queries.server";
import { toErrorResponse } from "~/lib/errors.server";

export async function loader({ request }: { request: Request }) {
  await requireUser(request);
  try {
    const url = new URL(request.url);
    const kindId = url.searchParams.get("kindId");
    const query = (url.searchParams.get("query") ?? "").slice(0, 200);
    return Response.json({
      models: await catalogModelOptions(kindId, query),
      kindId,
      query,
    });
  } catch (error) {
    throw toErrorResponse(error);
  }
}
