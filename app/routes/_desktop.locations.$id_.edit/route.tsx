import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { getLocation } from "~/domains/locations/locations.queries.server";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { locationEditSchema, locationMoveSchema } from "~/domains/locations/locations.schema";
import {
  deleteLocation,
  moveLocation,
  updateLocation,
} from "~/domains/locations/locations.mutations.server";
import { ZodForm } from "~/components/forms";
import { LocationFormFields } from "~/components/locations/location-form-fields";
import { LocationFormErrors } from "~/components/locations/location-form-errors";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Select } from "~/components/ui/select";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/locations/:id/edit` — one page, three intents, each through a location mutation.
 *
 * `_action` dispatches (`update` · `move` · `delete`), the same convention the
 * rooms edit route already uses. **A refusal is a returned value, never a
 * throw**: `moveLocation` refusing a move into the node's own subtree and
 * `deleteLocation` refusing a node that still has children both come back as
 * `ValidationError`, and the action converts them into `{ fieldErrors,
 * formErrors }` so the page re-renders with the reason on it. Un-caught, each
 * would be a 500 on a perfectly ordinary user mistake.
 *
 * `move` and `delete` return a `formErrors` list as well as field errors,
 * because their refusals are about the *state of the tree* ("4 untergeordnete
 * Standorte"), not about one wrong field.
 *
 * The move picker lists every other location **including the node's own
 * descendants**, because refusing a move into your own subtree is the exact
 * case that must stay visible; hiding the impossible choices would make
 * the guard unreachable from the UI and untestable through it.
 */
export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "locations.meta.edit", {
        name: data?.location.name ?? t(locale, "locations.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const locale = resolveLocale(request);
  const location = await getLocation(params.id);
  if (!location) throw toErrorResponse(new NotFoundError(t(locale, "err.location.notFound")));
  const all = await listLocationTree();
  return { location, candidates: all.filter((node) => node.id !== location.id) };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "update");

  const location = await getLocation(params.id);
  if (!location) throw toErrorResponse(new NotFoundError(t(locale, "err.location.notFound")));

  try {
    if (intent === "delete") {
      await deleteLocation(actor, location.id);
      await emitChange({ entityType: "location", id: location.id, op: "deleted" });
      return redirect("/locations");
    }

    if (intent === "move") {
      const result = safeParse(
        locationMoveSchema,
        {
          id: location.id,
          parentId: formDataToObject(form).parentId,
        },
        locale,
      );
      if (!result.success) {
        return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
      }
      await moveLocation(actor, location.id, result.data.parentId);
      await emitChange({ entityType: "location", id: location.id, op: "updated" });
      return redirect(`/locations/${location.id}`);
    }

    const result = safeParse(
      locationEditSchema,
      { ...formDataToObject(form), id: location.id },
      locale,
    );
    if (!result.success) {
      return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
    }
    await updateLocation(actor, location.id, result.data);
    await emitChange({ entityType: "location", id: location.id, op: "updated" });
    return redirect(`/locations/${location.id}`);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

export default function EditLocation({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { location, candidates } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("locations.edit.title", { name: location.name })}</h1>
        <Link
          to={`/locations/${location.id}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          {t("locations.edit.back")}
        </Link>
      </div>

      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <LocationFormErrors formErrors={actionData?.formErrors} />
        <LocationFormFields
          defaults={{
            name: location.name,
            kind: location.kind,
            code: location.code,
            address: location.address,
            description: location.description,
          }}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("locations.edit.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to={`/locations/${location.id}`}>{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>

      <ZodForm
        method="post"
        fieldErrors={actionData?.fieldErrors}
        className="border-border mt-6 border-t pt-4"
      >
        <LocationFormErrors formErrors={actionData?.formErrors} />
        <h2 className="text-base font-semibold">{t("locations.edit.moveHeading")}</h2>
        <input type="hidden" name="_action" value="move" />
        <Label htmlFor="parentId">{t("locations.edit.moveLabel")}</Label>
        <Select id="parentId" name="parentId" defaultValue={location.parentId ?? ""}>
          <option value="">{t("locations.form.topLevel")}</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {`${"— ".repeat(c.depth)}${c.name}`}
            </option>
          ))}
        </Select>
        {actionData?.fieldErrors?.parentId?.[0] ? (
          // `moveLocation` refuses a subtree move with `fieldErrors.parentId`;
          // the raw select has no FormField, so the reason is rendered here or
          // not at all.
          <p role="alert" className="text-destructive text-sm">
            {actionData.fieldErrors.parentId[0]}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">{t("locations.edit.moveHint")}</p>
        <Button type="submit" disabled={busy}>
          {t("locations.edit.move")}
        </Button>
      </ZodForm>

      <Form
        method="post"
        className="border-border mt-6 border-t pt-4"
        onSubmit={(e) => {
          if (!confirm(t("locations.edit.confirmDelete", { name: location.name })))
            e.preventDefault();
        }}
      >
        <input type="hidden" name="_action" value="delete" />
        <Button type="submit" variant="destructive" disabled={busy}>
          {t("locations.edit.delete")}
        </Button>
        <p className="text-muted-foreground mt-1 text-xs">{t("locations.edit.deleteHint")}</p>
      </Form>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
