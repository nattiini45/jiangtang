import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listNotes } from "~/domains/notes/notes.queries.server";
import { EmptyState } from "~/components/states/empty-state";
import { Button } from "~/components/ui/button";
import { NotebookPen, Pin } from "lucide-react";
import { formatDate } from "~/i18n/format";
import { MobileRouteErrorBoundary as RouteErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile notes list — read-only reuse of the desktop list query. Rows tap
 * through to the note page; creating happens through the capture sheet.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.notes") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const notes = await listNotes();
  return { notes };
}

export default function MobileNotesIndex({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const { notes } = loaderData;
  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 [overflow-wrap:anywhere]">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("nav.notes")}</h1>
        <Button asChild className="min-h-11">
          <Link to="/m/notes/new">{t("mobile.menu.newNote")}</Link>
        </Button>
      </div>
      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {notes.map((n) => (
          <li key={n.id}>
            <Link
              to={`/m/notes/${n.id}`}
              className="active:bg-selected flex min-h-12 w-full flex-col justify-center gap-0.5 px-3 py-2 text-left transition-colors duration-80"
            >
              <span className="break-words text-sm font-semibold">
                {n.pinned ? (
                  <Pin className="mr-1 inline size-3" aria-label={t("notes.list.pinnedAria")} />
                ) : null}
                {n.title}
              </span>
              <span className="text-muted-foreground nums break-words text-xs">
                {t("mobile.notes.updated", { date: formatDate(locale, n.updatedAt) })}
                {n.tags.length > 0 ? ` · ${n.tags.join(", ")}` : ""}
              </span>
            </Link>
          </li>
        ))}
        {notes.length === 0 ? (
          <li>
            <EmptyState
              icon={NotebookPen}
              title={t("mobile.notes.empty")}
              action={{ to: "/m/notes/new", label: t("mobile.menu.newNote") }}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
