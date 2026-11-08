import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listNotes, listNoteTags } from "~/domains/notes/notes.queries.server";
import { listProjectOptions } from "~/domains/projects/projects.queries.server";
import { NoteList } from "~/components/notes/note-list";
import { badgeClassName } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Checkbox } from "~/components/ui/checkbox";
import { EmptyState } from "~/components/states/empty-state";
import { NotebookPen } from "lucide-react";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/notes` — the note index. Pinned notes form their own section above
 * the rest (the query already orders pinned-first, so the split is a render
 * detail, not a second query).
 *
 * Filters live in the URL and degrade to unfiltered on garbage — the
 * `list-filter-parsing` contract:
 *
 * - `q` — title or body, case-insensitive.
 * - `tag` — exact tag; the chips under the filter row come from
 *   `listNoteTags` and are themselves links.
 * - `project` — the project SLUG; unknown → unfiltered.
 * - `archived=1` — show archived notes instead of active ones.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "notes.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  const url = new URL(request.url);
  const p = (name: string) => url.searchParams.get(name)?.trim() || undefined;

  const projects = await listProjectOptions();
  const projectParam = p("project");
  const projectId = projectParam ? projects.find((x) => x.slug === projectParam)?.id : undefined;

  const archived = p("archived") === "1";
  const [notes, tags] = await Promise.all([
    listNotes({ q: p("q"), tag: p("tag"), projectId, archived: archived ? "only" : "exclude" }),
    listNoteTags(),
  ]);

  return {
    notes,
    tags,
    projects,
    isAdmin: actor.role === "ADMIN",
    filters: { q: p("q") ?? "", tag: p("tag") ?? "", project: projectParam ?? "", archived },
  };
}

export default function NotesIndex({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const { notes, tags, projects, filters, isAdmin } = loaderData;
  const pinned = notes.filter((n) => n.pinned);
  const rest = notes.filter((n) => !n.pinned);
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("notes.list.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("notes.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {isAdmin ? (
            <Button variant="secondary" asChild>
              <Link to="/notes/import">{t("notes.list.import")}</Link>
            </Button>
          ) : null}
          <Button asChild>
            <Link to="/notes/new">{t("notes.list.new")}</Link>
          </Button>
        </div>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-3">
        <Input
          name="q"
          defaultValue={filters.q}
          placeholder={t("notes.list.searchPlaceholder")}
          className="max-w-[16rem]"
          aria-label={t("notes.list.searchAria")}
        />
        <Input
          name="tag"
          defaultValue={filters.tag}
          placeholder={t("notes.list.tagPlaceholder")}
          className="max-w-[10rem]"
          aria-label={t("notes.list.tagAria")}
        />
        <Select
          name="project"
          defaultValue={filters.project}
          className="max-w-[16rem]"
          onChange={autoSubmit}
          aria-label={t("notes.list.projectAria")}
        >
          <option value="">{t("notes.list.allProjects")}</option>
          {projects.map((proj) => (
            <option key={proj.id} value={proj.slug}>
              {proj.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            name="archived"
            value="1"
            defaultChecked={filters.archived}
            onChange={autoSubmit}
          />
          {t("notes.list.archivedOnly")}
        </label>
        <Button type="submit" variant="secondary" size="compact">
          {t("notes.list.filterSubmit")}
        </Button>
      </Form>

      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label={t("notes.list.tagsAria")}>
          {tags.map(({ tag, count }) => (
            <Link
              key={tag}
              to={`/notes?tag=${encodeURIComponent(tag)}${filters.archived ? "&archived=1" : ""}`}
              className={`${badgeClassName} hover:bg-tint-hover transition-colors duration-80`}
            >
              {tag} <span className="text-muted-foreground nums">{count}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {pinned.length > 0 ? (
        <section className="bg-card shadow-surface-2 rounded-lg p-4">
          <h2 className="mb-2 text-base font-semibold">{t("notes.list.pinned")}</h2>
          <NoteList notes={pinned} />
        </section>
      ) : null}
      <section className="bg-card shadow-surface-2 rounded-lg p-4">
        {pinned.length > 0 ? (
          <h2 className="mb-2 text-base font-semibold">{t("notes.list.all")}</h2>
        ) : null}
        <NoteList
          notes={rest}
          emptyMessage={
            <EmptyState
              icon={NotebookPen}
              title={filters.archived ? t("notes.list.emptyArchived") : t("notes.list.empty")}
              hint={t("notes.list.emptyHint")}
              action={{ to: "/notes/new", label: t("notes.list.emptyAction") }}
            />
          }
        />
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
