import { data } from "react-router";
import { z } from "zod";
import { Prisma } from "~/generated/prisma/client";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { parseForm } from "~/lib/validation.server";
import {
  localizeFieldErrors,
  toErrorResponse,
  ValidationError,
  FieldNameConflictError,
  type FieldErrors,
} from "~/lib/errors.server";
import { currentLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { structureActionSchema } from "~/lib/equipment-kinds/structure.schema";
import {
  createDeviceKind,
  createFunctionGroup,
  deleteStructureEntry,
  listStructure,
  updateDeviceKind,
  updateFunctionGroup,
} from "~/lib/equipment-kinds/structure.server";
import { StructurePage } from "~/components/structure/structure-page";
import { KindLibrary } from "~/components/structure/kind-library";
import {
  createNamedCustomField,
  updateCustomField,
  updateFieldOptions,
  deleteCustomField,
} from "~/lib/custom-fields/definitions.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import {
  fieldAdminSchema,
  parseFieldAdminPayload,
  moveCustomField,
} from "~/lib/custom-fields/admin.server";
import {
  installLibraryKinds,
  libraryInstallSchema,
  listKindLibrary,
} from "~/lib/equipment-kinds/library.server";
export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "ADMIN");
  try {
    const [groups, library, rooms, devices] = await Promise.all([
      listStructure(),
      listKindLibrary(),
      getFieldSchema("ROOM"),
      getFieldSchema("EQUIPMENT"),
    ]);
    return {
      groups,
      library,
      fields: [...rooms, ...devices].map((field) => ({
        ...field,
        unit: field.unit?.label ?? null,
      })),
    };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new Response(null, { status: 403 });
  try {
    let fieldId: string | null = null;
    const input = await parseForm(
      request,
      z.union([
        fieldAdminSchema,
        structureActionSchema,
        z.object({
          intent: z.literal("install"),
          keys: z.preprocess(
            (value) => (typeof value === "string" ? [value] : value),
            libraryInstallSchema.shape.keys,
          ),
        }),
      ]),
    );
    if (input.intent === "field") {
      const change = parseFieldAdminPayload(input.payload);
      if (change.op === "create") fieldId = (await createNamedCustomField(actor, change.input)).id;
      else if (change.op === "update") fieldId = (await updateCustomField(actor, change.input)).id;
      else if (change.op === "options")
        fieldId = (await updateFieldOptions(actor, change.input, true)).id;
      else if (change.op === "move") await moveCustomField(actor, change.input);
      else await deleteCustomField(actor, change.id, true);
    } else if (input.intent === "install") {
      await installLibraryKinds(actor, { keys: input.keys });
    } else if (input.intent === "create") {
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
    return {
      changed: true,
      fieldErrors: {} as FieldErrors,
      formErrors: [] as string[],
      fieldId,
      holderId: null as string | null,
    };
  } catch (caught) {
    const error =
      caught instanceof z.ZodError
        ? new ValidationError(z.flattenError(caught).fieldErrors)
        : caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002"
          ? new ValidationError({}, [t(currentLocale(), "fields.admin.optionTaken")])
          : caught;
    if (error instanceof ValidationError)
      return data(
        {
          changed: false,
          fieldErrors: localizeFieldErrors(currentLocale(), error.fieldErrors),
          formErrors: error.formErrors,
          fieldId: null as string | null,
          holderId: error instanceof FieldNameConflictError ? error.holderId : null,
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
  return (
    <StructurePage
      groups={loaderData.groups}
      fields={loaderData.fields}
      libraryAction={<KindLibrary library={loaderData.library} />}
    />
  );
}
