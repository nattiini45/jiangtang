import { tr } from "~/i18n/request-locale.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { ValidationError } from "~/lib/errors.server";
import { db } from "~/lib/db.server";
import { parseMarkdownNote } from "./notes.markdown";
import { createNoteInTx, updateNoteInTx } from "./notes.mutations.server";

/**
 * Markdown note import — the `bulkCreateTasks` contract one domain
 * over: whole-batch atomicity inside ONE `txWithAudit`, and every refusal is
 * prefixed with the FILE NAME so a rejection in a 200-file folder is findable.
 *
 * A front-matter `id` that matches an existing note UPDATES it (audit
 * `NoteImported {updated: true}`); a free `id` is taken verbatim so
 * export → delete → import restores the same note, links intact. Only a
 * cuid-shaped `id` is honoured — a hand-edited front-matter `id` that isn't
 * `/^[a-z0-9]{8,40}$/i` is ignored and the note is created fresh, rather than
 * letting an import plant an arbitrary primary key.
 */
export interface MarkdownFile {
  name: string;
  text: string;
}

export async function importMarkdownNotes(
  actor: AuditActor,
  files: MarkdownFile[],
): Promise<{ created: number; updated: number }> {
  const projects = await db.project.findMany({ select: { id: true, slug: true } });
  const projectBySlug = new Map(projects.map((p) => [p.slug, p.id]));

  return txWithAudit(actor, async (tx, audit) => {
    let created = 0;
    let updated = 0;
    for (const file of files) {
      if (!file.text.trim()) {
        throw new ValidationError({}, [tr("work.err.import.fileEmpty", { file: file.name })]);
      }
      let parsed;
      try {
        parsed = parseMarkdownNote(file.name, file.text);
      } catch (error) {
        throw new ValidationError({}, [
          tr("work.err.import.fileError", {
            file: file.name,
            message: error instanceof Error ? error.message : tr("work.err.import.fileUnreadable"),
          }),
        ]);
      }
      const projectId = parsed.projectSlug ? projectBySlug.get(parsed.projectSlug) : undefined;
      if (parsed.projectSlug && !projectId) {
        throw new ValidationError({}, [
          tr("work.err.import.fileProjectSlugUnknown", {
            file: file.name,
            slug: parsed.projectSlug,
          }),
        ]);
      }
      if (parsed.locationId) {
        const location = await tx.location.findUnique({
          where: { id: parsed.locationId },
          select: { id: true },
        });
        if (!location) {
          throw new ValidationError({}, [
            tr("work.err.import.fileLocationUnknown", {
              file: file.name,
              id: parsed.locationId,
            }),
          ]);
        }
      }
      const input = {
        title: parsed.title,
        body: parsed.body,
        pinned: parsed.pinned,
        tags: parsed.tags,
        projectId,
        locationId: parsed.locationId,
      };
      const id = parsed.id && /^[a-z0-9]{8,40}$/i.test(parsed.id) ? parsed.id : undefined;
      if (id) {
        const existing = await tx.note.findUnique({ where: { id }, select: { id: true } });
        if (existing) {
          await updateNoteInTx(tx, audit, id, input);
          updated++;
        } else {
          await createNoteInTx(tx, audit, actor, { ...input, id });
          created++;
        }
      } else {
        await createNoteInTx(tx, audit, actor, input);
        created++;
      }
    }
    return { created, updated };
  });
}
