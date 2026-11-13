import { z, safeParseForm } from "~/lib/validation.server";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { homeLayoutSchema } from "~/domains/dashboard/home-layout";
import { saveOwnHomeLayout } from "~/domains/auth/home-layout.server";
import type { Route } from "./+types/route";

const schema = z.object({
  layout: z
    .string()
    .max(2048)
    .transform((value, ctx) => {
      let input: unknown;
      try {
        input = JSON.parse(value);
      } catch {
        input = null;
      }
      const parsed = homeLayoutSchema.safeParse(input);
      if (parsed.success) return parsed.data;
      ctx.addIssue({ code: "custom", message: "dashboard.home.invalid" });
      return z.NEVER;
    }),
});

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  try {
    const result = await safeParseForm(request, schema);
    if (!result.success) return Response.json({ ok: false }, { status: 422 });
    await saveOwnHomeLayout(actor, result.data.layout);
    return { ok: true };
  } catch (error) {
    throw toErrorResponse(error);
  }
}
