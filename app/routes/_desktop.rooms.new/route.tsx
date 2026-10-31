import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { listCampuses } from "~/domains/rooms/rooms.queries.server";
import { roomCreateSchema } from "~/domains/rooms/rooms.schema";
import { createRoom } from "~/domains/rooms/rooms.mutations.server";
import { ZodForm } from "~/components/forms";
import { RoomFormFields } from "~/components/rooms/room-form-fields";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "rooms.meta.new") }];
}

export async function loader(_: Route.LoaderArgs) {
  return { campuses: await listCampuses() };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, roomCreateSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors };
  try {
    const room = await createRoom(actor, result.data);
    await emitChange({ entityType: "room", id: room.id, op: "created" });
    return redirect(`/rooms/${room.slug}`);
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function NewRoom({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">{t("rooms.new.title")}</h1>
        <Link to="/rooms" className="text-muted-foreground text-sm hover:underline">
          {t("rooms.new.back")}
        </Link>
      </div>
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <RoomFormFields campuses={loaderData.campuses} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.creating") : t("rooms.new.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/rooms">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
