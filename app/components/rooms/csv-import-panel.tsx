import { Form, useNavigation } from "react-router";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";

export interface CsvPreviewView {
  validCount: number;
  invalid: { line: number; messages: string[] }[];
}

export interface CsvImportActionData {
  csv?: string;
  preview?: CsvPreviewView;
  error?: string;
}

/**
 * Shared paste → preview → commit panel for bulk CSV import (rooms + equipment).
 * The form holds the raw CSV; "Preview" validates (no writes), "Import …"
 * commits the valid rows in one transaction. The CSV round-trips via the textarea.
 */
export function CsvImportPanel({
  description,
  headerLine,
  sampleRow,
  actionData,
}: {
  description: string;
  headerLine: string;
  sampleRow?: string;
  actionData?: CsvImportActionData;
}) {
  const t = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const preview = actionData?.preview;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{description}</p>

      <details className="border-border border p-3">
        <summary className="text-muted-foreground cursor-pointer text-xs uppercase tracking-wide">
          {t("common.csv.expectedColumns")}
        </summary>
        <pre className="mt-2 overflow-auto font-mono text-xs">
          {headerLine}
          {sampleRow ? `\n${sampleRow}` : ""}
        </pre>
      </details>

      <Form method="post" className="flex flex-col gap-3">
        <Textarea
          name="csv"
          rows={10}
          defaultValue={actionData?.csv ?? ""}
          placeholder={headerLine}
          className="font-mono text-xs"
        />
        <div className="flex gap-2">
          <Button type="submit" name="_action" value="preview" variant="outline" disabled={busy}>
            {t("common.csv.preview")}
          </Button>
          {preview && preview.validCount > 0 ? (
            <Button type="submit" name="_action" value="commit" disabled={busy}>
              {t("common.csv.commit", { count: preview.validCount })}
            </Button>
          ) : null}
        </div>
      </Form>

      {actionData?.error ? (
        <p className="text-destructive text-sm" role="alert">
          {actionData.error}
        </p>
      ) : null}

      {preview ? (
        <div className="border-border border">
          <div className="border-border border-b px-3 py-2 text-sm">
            <span className="text-status-operational font-mono">{preview.validCount}</span>{" "}
            {t("common.csv.valid")}
            {preview.invalid.length > 0 ? (
              <>
                {" · "}
                <span className="text-destructive font-mono">{preview.invalid.length}</span>{" "}
                {t("common.csv.invalid")}
              </>
            ) : null}
          </div>
          {preview.invalid.length > 0 ? (
            <ul className="divide-border divide-y text-sm">
              {preview.invalid.map((r) => (
                <li key={r.line} className="px-3 py-2">
                  <span className="text-muted-foreground font-mono text-xs">
                    {t("common.csv.line", { line: r.line })}
                  </span>{" "}
                  <span className="text-destructive">{r.messages.join("; ")}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
