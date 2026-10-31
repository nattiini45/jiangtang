import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { t, type MessageKey } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { tRich } from "~/i18n/rich";
import { useT } from "~/i18n/use-t";
import { resolveLocale } from "~/i18n/locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { importWorkspace } from "~/domains/transfer/transfer.server";
import { Button } from "~/components/ui/button";
import { RouteErrorBoundary } from "~/components/route-error-boundary";

/**
 * `/import` — the import centre: one card per existing importer with a
 * line on the expected format, plus the workspace JSON export and the
 * all-or-nothing JSON import. The JSON file uploads as multipart `file`;
 * `importWorkspace` validates, resolves references, and writes everything in
 * one transaction — or nothing.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "importHub.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return {};
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: t(locale, "err.import.selectJson") };
  }
  if (file.size > 20 * 1024 * 1024) {
    return { error: t(locale, "err.import.tooLarge") };
  }
  try {
    const summary = await importWorkspace(actor, JSON.parse(await file.text()));
    await emitChange({ entityType: "task", id: "import", op: "updated" });
    return { ok: true as const, summary };
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { error: t(locale, "err.import.invalidJson") };
    }
    if (e instanceof ValidationError) {
      return { error: t(locale, "err.import.rejected"), details: e.formErrors };
    }
    throw toErrorResponse(e);
  }
}

const IMPORTERS: { to: string; titleKey: MessageKey; hintKey: MessageKey }[] = [
  { to: "/rooms/import", titleKey: "importHub.rooms.title", hintKey: "importHub.rooms.hint" },
  {
    to: "/inventory/import",
    titleKey: "importHub.equipment.title",
    hintKey: "importHub.equipment.hint",
  },
  {
    to: "/inventory/stock/import",
    titleKey: "importHub.stock.title",
    hintKey: "importHub.stock.hint",
  },
  { to: "/tasks/import", titleKey: "importHub.tasks.title", hintKey: "importHub.tasks.hint" },
  { to: "/notes/import", titleKey: "importHub.notes.title", hintKey: "importHub.notes.hint" },
];

export default function ImportRoute({ actionData }: Route.ComponentProps) {
  const t = useT();
  const format = <code className="font-mono">jiangtang-workspace</code>;
  const navigation = useNavigation();
  const importing = navigation.state === "submitting";
  const data = actionData;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-lg font-medium">{t("nav.import")}</h1>
        <p className="text-muted-foreground text-sm">{t("importHub.subtitle")}</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {IMPORTERS.map((i) => (
          <Link
            key={i.to}
            to={i.to}
            className="border-border hover:border-foreground/40 block border p-4"
          >
            <div className="font-medium">{t(i.titleKey)}</div>
            <p className="text-muted-foreground mt-1 text-xs">{t(i.hintKey)}</p>
          </Link>
        ))}
      </section>

      <section className="border-border grid gap-3 border p-4 sm:grid-cols-2">
        <div>
          <h2 className="font-mono text-sm font-medium">{t("importHub.export.title")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {tRich(t, "importHub.export.body", { format })}
          </p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <a href="/export/workspace.json" download>
              {t("importHub.export.download")}
            </a>
          </Button>
        </div>

        <div>
          <h2 className="font-mono text-sm font-medium">{t("importHub.import.title")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {tRich(t, "importHub.import.body", { format })}
          </p>
          <Form
            method="post"
            encType="multipart/form-data"
            className="mt-3 flex items-center gap-2"
          >
            <input
              type="file"
              name="file"
              accept="application/json,.json"
              required
              aria-label={t("importHub.import.fileAria")}
              className="text-sm file:mr-3 file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
            />
            <Button type="submit" size="sm" disabled={importing}>
              {importing ? t("importHub.import.submitting") : t("common.import")}
            </Button>
          </Form>

          {data && "error" in data && data.error ? (
            <div className="text-destructive mt-3 text-sm" role="alert">
              <p>{data.error}</p>
              {"details" in data && data.details ? (
                <ul className="mt-1 list-inside list-disc text-xs">
                  {data.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {data && "ok" in data && data.ok ? (
            <p className="mt-3 text-sm text-green-600 dark:text-green-400" role="status">
              {t("importHub.import.done", {
                projects: data.summary.projects,
                tasks: data.summary.tasks,
                notes: data.summary.notes,
                edges: data.summary.edges,
              })}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
