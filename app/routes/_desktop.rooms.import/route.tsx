import { Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireRole } from "~/lib/auth.server";
import { formDataToObject } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { previewCsv } from "~/lib/csv/preview";
import { roomCsvRowSchema } from "~/domains/rooms/rooms.schema";
import { bulkCreateRooms } from "~/domains/rooms/rooms.mutations.server";
import { CsvImportPanel } from "~/components/rooms/csv-import-panel";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

const HEADER =
  "name,raumnummer,campus,gebaeude,plaetze,besitzer,status,projektor,mikrofonie,tafel,webkonferenz,aufzeichnung,medienschluessel,videoeingaenge,tonausgaenge";
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "rooms.meta.import") }];
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireRole(request, "ADMIN");
  const locale = resolveLocale(request);
  const obj = formDataToObject(await request.formData());
  const intent = String(obj._action ?? "preview");
  const csv = String(obj.csv ?? "");
  const preview = previewCsv(csv, roomCsvRowSchema, locale);
  const view = {
    validCount: preview.valid.length,
    invalid: preview.invalid.map(({ line, messages }) => ({ line, messages })),
  };

  if (intent === "commit") {
    if (preview.valid.length === 0)
      return { csv, preview: view, error: t(locale, "err.import.noValidRows") };
    try {
      await bulkCreateRooms(
        actor,
        preview.valid.map((v) => v.data),
      );
      await emitChange({ entityType: "room", id: "bulk", op: "created" });
      return redirect("/rooms");
    } catch (e) {
      if (e instanceof ValidationError) {
        return { csv, preview: view, error: Object.values(e.fieldErrors).flat().join("; ") };
      }
      throw toErrorResponse(e);
    }
  }
  return { csv, preview: view };
}

export default function RoomsImport({ actionData }: Route.ComponentProps) {
  const t = useT();
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("rooms.import.title")}</h1>
        <Link to="/rooms" className="text-muted-foreground text-sm hover:underline">
          {t("rooms.import.back")}
        </Link>
      </div>
      <CsvImportPanel
        description={t("rooms.import.description")}
        headerLine={HEADER}
        sampleRow={t("rooms.import.sample")}
        actionData={actionData}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
