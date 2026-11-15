import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { parseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { saveListColumns } from "~/lib/list-columns/columns.server";
export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new Response(null, { status: 403 });
  try {
    const input = await parseForm(
      request,
      z.object({
        scope: z.enum(["ROOM", "EQUIPMENT"]),
        columns: z.string().transform((value, ctx) => {
          try {
            return z.array(z.string()).max(12).parse(JSON.parse(value));
          } catch {
            ctx.addIssue({ code: "custom", message: "fields.columns.invalid" });
            return z.NEVER;
          }
        }),
      }),
    );
    await saveListColumns(actor, input.scope, input.columns);
    return { saved: true, error: "" };
  } catch (error) {
    if (error instanceof ValidationError)
      return data({ saved: false, error: "fields.columns.invalid" }, { status: 422 });
    throw toErrorResponse(error);
  }
}
