import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { listModels } from "~/domains/catalog/catalog.queries.server";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { equipmentCreateSchema } from "~/domains/inventory/inventory.schema";
import { createEquipment } from "~/domains/inventory/inventory.mutations.server";
import { ZodForm } from "~/components/forms";
import { EquipmentFormFields } from "~/components/inventory/equipment-form-fields";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "inventory.meta.new") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get("roomId") || undefined;
  const [models, rooms] = await Promise.all([listModels(), listRooms()]);
  return { models, rooms, roomId };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, equipmentCreateSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors };
  try {
    const eq = await createEquipment(actor, result.data);
    await emitChange({ entityType: "equipment", id: eq.id, op: "created" });
    return redirect(`/inventory/${eq.id}`);
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function NewEquipment({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">{t("inventory.new.title")}</h1>
        <Link to="/inventory" className="text-muted-foreground text-sm hover:underline">
          {t("inventory.new.back")}
        </Link>
      </div>
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <EquipmentFormFields
          models={loaderData.models}
          rooms={loaderData.rooms}
          defaults={
            loaderData.roomId ? { roomId: loaderData.roomId, mobility: "FIXED" } : undefined
          }
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.creating") : t("inventory.new.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/inventory">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
