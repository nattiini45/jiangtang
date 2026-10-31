import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { getNote } from "~/domains/notes/notes.queries.server";
import { noteToMarkdown } from "~/domains/notes/notes.markdown";
import { deriveSlug } from "~/lib/slug.server";

/**
 * `/notes/:id/export` — the markdown download. A resource route like
 * `attachments.$key`: top-level, so it is NOT under the `_desktop` layout and
 * guards itself with `requireUser`. The filename is the note's title run
 * through `deriveSlug` — German-aware, URL-safe, human-readable.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const note = await getNote(params.id);
  if (!note) throw new Response(t(resolveLocale(request), "err.notFoundBody"), { status: 404 });

  const markdown = noteToMarkdown(note);
  const filename = `${deriveSlug(note.title) || "notiz"}.md`;
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  });
}
