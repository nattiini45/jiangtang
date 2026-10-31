import { Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { previewCsv } from "~/lib/csv/preview";
import { taskCsvRowSchema } from "~/domains/tasks/tasks.schema";
import { bulkCreateTasks } from "~/domains/tasks/tasks.import.server";
import { CsvImportPanel } from "~/components/rooms/csv-import-panel";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import { TASK_PRIORITY_ALIASES, TASK_STATUS_ALIASES } from "~/lib/status";

/**
 * `/tasks/import` — bulk task ingest, the stock importer's shape —
 * paste, preview, commit — with the same two rules:
 *
 * 1. **Validation is `previewCsv` + `taskCsvRowSchema`** — the columns are the
 *    row schema's own keys, and the schema resolves what it can without the
 *    database (enum values OR their German or English labels, `DD.MM.YYYY` days, `1h30`
 *    estimates). What it cannot resolve — the `assignees` initials/emails and
 *    the `project` slug — is refused by the domain AT COMMIT, naming the row.
 * 2. **All-or-nothing per file** — one bad row aborts the whole file inside
 *    `bulkCreateTasks`' single `txWithAudit`; nothing is written, not even
 *    the audit rows of the rows that already imported.
 */
// The header line is the CSV file contract — parsed by the row schema, so it
// stays the fixed German column names in every locale; only the sample row
// (and the description) are localized.
const HEADER = "title,status,priority,start,due,estimate,labels,assignees,project";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "tasks.meta.import") }];
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const obj = formDataToObject(await request.formData());
  const intent = String(obj._action ?? "preview");
  const csv = String(obj.csv ?? "");
  const preview = previewCsv(csv, taskCsvRowSchema, locale);
  const view = {
    validCount: preview.valid.length,
    invalid: preview.invalid.map(({ line, messages }) => ({ line, messages })),
  };

  if (intent === "commit") {
    if (preview.invalid.length > 0) {
      const first = preview.invalid[0];
      return {
        csv,
        preview: view,
        error: t(locale, "err.import.aborted", {
          count: preview.invalid.length,
          line: first.line,
          messages: first.messages.join("; "),
        }),
      };
    }
    if (preview.valid.length === 0)
      return { csv, preview: view, error: t(locale, "err.import.noValidRows") };
    try {
      await bulkCreateTasks(actor, preview.valid);
      // One event for the file, not one per row — the stock importer's rule:
      // a 30-row import is 30 NOTIFYs nobody asked for.
      await emitChange({ entityType: "task", id: "bulk", op: "created" });
      return redirect("/tasks");
    } catch (e) {
      if (e instanceof ValidationError) {
        return {
          csv,
          preview: view,
          error: Object.values(e.fieldErrors).flat().concat(e.formErrors).join("; "),
        };
      }
      throw toErrorResponse(e);
    }
  }
  return { csv, preview: view };
}

export default function TaskImport({ actionData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-mono text-xl">{t("tasks.import.title")}</h1>
        <Link to="/tasks" className="text-muted-foreground text-sm hover:underline">
          {t("tasks.import.back")}
        </Link>
      </div>
      <CsvImportPanel
        description={t("tasks.import.description", {
          statuses: TASK_STATUS_ALIASES.labels(locale).join(" · "),
          priorities: TASK_PRIORITY_ALIASES.labels(locale).join(" · "),
        })}
        headerLine={HEADER}
        sampleRow={t("tasks.import.sample")}
        actionData={actionData}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
