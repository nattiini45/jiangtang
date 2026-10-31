import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { locationCreateSchema } from "~/domains/locations/locations.schema";
import { createLocation } from "~/domains/locations/locations.mutations.server";
import { ZodForm } from "~/components/forms";
import { LocationFormFields } from "~/components/locations/location-form-fields";
import { LocationFormErrors } from "~/components/locations/location-form-errors";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/locations/new` — create a location through `createLocation`.
 *
 * Every kind of node can be a parent, so the picker is the whole forest rather
 * than just the roots; `listLocationTree` returns depth, which the option labels
 * use as indentation.
 *
 * `?parent=<id>` preselects a parent, which is what the detail page's
 * "untergeordneter Standort" link carries. It is honoured **only when the id
 * resolves to a real node** — a stale or hand-edited value would otherwise fall
 * through to the `<Select>`'s first option and silently create at the root,
 * which is a successful-looking create that ignored the URL.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "locations.meta.new") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const parents = await listLocationTree();
  const requested = new URL(request.url).searchParams.get("parent");
  const defaultParentId = parents.some((p) => p.id === requested) ? requested : null;
  return { parents, defaultParentId };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, locationCreateSchema);
  if (!result.success) {
    return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
  }
  try {
    const location = await createLocation(actor, result.data);
    return redirect(`/locations/${location.id}`);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

export default function NewLocation({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">{t("locations.new.title")}</h1>
        <Link to="/locations" className="text-muted-foreground text-sm hover:underline">
          {t("locations.new.back")}
        </Link>
      </div>

      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <LocationFormErrors formErrors={actionData?.formErrors} />
        <LocationFormFields
          parents={loaderData.parents}
          defaultParentId={loaderData.defaultParentId}
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.creating") : t("locations.new.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/locations">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
