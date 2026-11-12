import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { parseForm } from "~/lib/validation.server";
import {
  localizeFieldErrors,
  toErrorResponse,
  ValidationError,
  type FieldErrors,
} from "~/lib/errors.server";
import { currentLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { structureActionSchema } from "~/domains/structure/structure.schema";
import {
  createDeviceKind,
  createFunctionGroup,
  deleteStructureEntry,
  listStructure,
  updateDeviceKind,
  updateFunctionGroup,
} from "~/domains/structure/structure.mutations.server";
import { StructurePage } from "~/components/structure/structure-page";
export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  try {
    return { groups: await listStructure() };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new Response(null, { status: 403 });
  try {
    const input = await parseForm(request, structureActionSchema);
    if (input.intent === "create") {
      if (input.entity === "kind")
        await createDeviceKind(actor, { name: input.name!, groupId: input.groupId! });
      else await createFunctionGroup(actor, { name: input.name! });
    } else {
      if (!input.id) throw new ValidationError({}, [t(currentLocale(), "err.notFound")]);
      if (input.intent === "delete") await deleteStructureEntry(actor, input.entity, input.id);
      else {
        const update = {
          name: input.name,
          groupId: input.groupId,
          position: input.position,
          moveDevicesTo: input.moveDevicesTo,
          archived:
            input.intent === "archive" ? true : input.intent === "restore" ? false : undefined,
        };
        if (input.entity === "kind") await updateDeviceKind(actor, input.id, update);
        else await updateFunctionGroup(actor, input.id, update);
      }
    }
    return { changed: true, fieldErrors: {} as FieldErrors, formErrors: [] as string[] };
  } catch (caught) {
    const error =
      caught instanceof z.ZodError
        ? new ValidationError(z.flattenError(caught).fieldErrors)
        : caught;
    if (error instanceof ValidationError)
      return data(
        {
          changed: false,
          fieldErrors: localizeFieldErrors(currentLocale(), error.fieldErrors),
          formErrors: error.formErrors,
        },
        { status: 422 },
      );
    throw toErrorResponse(error);
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: `${t(metaLocale(matches), "admin.structure.title")} · Jiangtang` }];
}
export default function Structure({ loaderData }: Route.ComponentProps) {
  return <StructurePage groups={loaderData.groups} />;
}
