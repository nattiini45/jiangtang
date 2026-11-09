import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { toErrorResponse } from "~/lib/errors.server";
import { requireNote } from "~/domains/notes/notes.queries.server";
import { MarkdownPreview } from "~/components/notes/markdown-preview";
import { ViewSwitch } from "~/components/layout/view-switch";
import { buttonVariants } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { formatDateTime } from "~/i18n/format";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: translate(locale, "notes.meta.detail", {
        name: data?.note.title ?? translate(locale, "notes.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  try {
    return { note: await requireNote(params.id!) };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export default function MobileNoteDetail({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const { note } = loaderData;
  return (
    <div className="flex min-w-0 flex-col gap-6 px-4 py-4 [overflow-wrap:anywhere]">
      <header className="flex min-w-0 flex-col items-start gap-2">
        <Link to="/m/notes" className={`${buttonVariants({ variant: "tertiary" })} min-h-11`}>
          {t("mobileDetails.noteBack")}
        </Link>
        <h1 className="text-lg font-bold">{note.title}</h1>
        <p className="text-muted-foreground nums text-xs">
          {t("mobile.notes.updated", { date: formatDateTime(locale, note.updatedAt) })}
        </p>
        <div className="flex max-w-full flex-wrap gap-2">
          {note.pinned ? <Badge>{t("notes.detail.pinned")}</Badge> : null}
          {note.archivedAt ? <Badge>{t("notes.detail.archived")}</Badge> : null}
          {note.tags.map((tag) => (
            <Badge key={tag} className="h-auto min-h-6 max-w-full whitespace-normal">
              {tag}
            </Badge>
          ))}
        </div>
      </header>
      {note.body ? (
        <div className="min-w-0 max-w-full overflow-x-auto [&_a]:inline-block [&_a]:min-h-11 [&_a]:py-3 [&_img]:max-w-full">
          <MarkdownPreview source={note.body} nestedHeadings />
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t("mobileDetails.noteEmpty")}</p>
      )}
      <ViewSwitch
        view="desktop"
        next={`/notes/${note.id}`}
        className="text-muted-foreground flex min-h-11 items-center justify-center text-sm underline underline-offset-4"
      >
        {t("mobileDetails.desktop")}
      </ViewSwitch>
    </div>
  );
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
