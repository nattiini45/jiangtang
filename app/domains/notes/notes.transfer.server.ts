import type { Tx } from "~/lib/db.server";
import type { AuditActor, AuditFn } from "~/lib/audit.server";
import { tr } from "~/i18n/request-locale.server";
import { ValidationError } from "~/lib/errors.server";
import type { TransferNote } from "~/domains/transfer/transfer.schema";

/**
 * In-transaction note upserts for the workspace import. The
 * file carries no author — created rows get `authorId = actor` (Note.author
 * is `Restrict`/non-null); on update the existing author is kept, only
 * content fields move.
 */
export async function importNotesInTx(
  tx: Tx,
  audit: AuditFn,
  actor: AuditActor,
  rows: TransferNote[],
  projectBySlug: Map<string, string>,
): Promise<void> {
  // Note.author is non-null + Restrict: like `createNote`, a note created by an
  // import still needs a signed-in author — a refusal, not a silent null.
  if (rows.length > 0 && !actor?.id) {
    throw new ValidationError({}, [tr("work.err.noteImport.authorRequired")]);
  }
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const projectIdByRow = new Map<string, string | null>();
  const locationIdByRow = new Map<string, string | null>();

  for (const [i, n] of rows.entries()) {
    const label = tr("work.err.import.noteLabel", { index: i + 1, title: n.title });
    if (seenIds.has(n.id)) errors.push(`${label}: ${tr("work.err.import.duplicateId")}`);
    seenIds.add(n.id);

    let projectId: string | null = null;
    if (n.projectSlug) {
      projectId = projectBySlug.get(n.projectSlug) ?? null;
      if (!projectId) {
        errors.push(
          `${label}: ${tr("work.err.import.projectSlugUnknown", { slug: n.projectSlug })}`,
        );
      }
    }
    projectIdByRow.set(n.id, projectId);

    let locationId: string | null = null;
    if (n.locationId) {
      const loc = await tx.location.findUnique({
        where: { id: n.locationId },
        select: { id: true },
      });
      if (!loc)
        errors.push(`${label}: ${tr("work.err.import.locationIdUnknown", { id: n.locationId })}`);
      else locationId = loc.id;
    }
    locationIdByRow.set(n.id, locationId);
  }
  if (errors.length > 0) throw new ValidationError({}, errors);

  for (const n of rows) {
    const data = {
      title: n.title,
      body: n.body,
      tags: n.tags,
      pinned: n.pinned,
      projectId: projectIdByRow.get(n.id) ?? null,
      locationId: locationIdByRow.get(n.id) ?? null,
      archivedAt: n.archivedAt,
    };
    const before = await tx.note.findUnique({ where: { id: n.id }, select: { id: true } });
    if (before) {
      // The version bump makes an editor still open on the old text conflict.
      await tx.note.update({ where: { id: n.id }, data: { ...data, version: { increment: 1 } } });
    } else {
      await tx.note.create({ data: { ...data, id: n.id, authorId: actor.id! } });
    }
    await audit({
      action: before ? "NoteUpdated" : "NoteImported",
      entityType: "note",
      entityId: n.id,
      data: { title: n.title, viaImport: true },
    });
  }
}
