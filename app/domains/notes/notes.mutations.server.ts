import { tr } from "~/i18n/request-locale.server";
import { NotFoundError, NoteConflictError, ValidationError } from "~/lib/errors.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { type Tx } from "~/lib/db.server";
import type { Note } from "~/generated/prisma/client";
import { CUID_PATTERN } from "~/domains/transfer/transfer.schema";
import type { NoteCreateInput } from "./notes.schema";

/**
 * Notes-domain mutations. Every one runs through `txWithAudit`, so the
 * `ActivityLog` row commits with the change or not at all — and a refused or
 * unchanged mutation writes nothing at all. entityType `"note"`.
 *
 * **`updateNote` diffs before writing** because the editor's autosave calls it
 * every 1.5 s while a note is open: a save that rewrites identical values is
 * not an event, and the audit row names only the changed FIELD names — the
 * body text never enters the log.
 *
 * **`updateNote` is optimistic**: the caller passes the `version` it loaded,
 * and a write against any other version is refused with `NoteConflictError`,
 * so a stale tab cannot silently replace a colleague's newer text.
 */

/** FK refs validated as field errors, like the locations domain does. */
async function requireProject(tx: Tx, id: string): Promise<void> {
  const project = await tx.project.findUnique({ where: { id }, select: { id: true } });
  if (!project) throw new ValidationError({ projectId: [tr("work.err.project.unknown")] });
}

async function requireLocation(tx: Tx, id: string): Promise<void> {
  const location = await tx.location.findUnique({ where: { id }, select: { id: true } });
  if (!location) throw new ValidationError({ locationId: [tr("work.err.note.locationUnknown")] });
}

async function validateRefs(
  tx: Tx,
  input: { projectId?: string; locationId?: string },
): Promise<void> {
  if (input.projectId) await requireProject(tx, input.projectId);
  if (input.locationId) await requireLocation(tx, input.locationId);
}

export async function createNote(
  actor: AuditActor,
  input: NoteCreateInput,
  clientId?: string,
): Promise<Note> {
  // authorId is NOT NULL + Restrict on purpose (schema comment): a note
  // without an author guts the audit spine, so this is a refusal, not a
  // silent null.
  if (!actor?.id) throw new ValidationError({}, [tr("work.err.note.authorRequired")]);
  if (clientId !== undefined && !CUID_PATTERN.test(clientId)) {
    throw new ValidationError({ clientId: [tr("work.err.invalidClientId")] });
  }
  return txWithAudit(actor, async (tx, audit) => {
    if (clientId !== undefined) {
      // Idempotent capture: a replayed/doubled submit returns the row
      // the first submit created — no second row, no second audit entry.
      const existing = await tx.note.findUnique({ where: { id: clientId } });
      if (existing) return existing;
    }
    await validateRefs(tx, input);
    const note = await tx.note.create({
      data: {
        ...(clientId ? { id: clientId } : {}),
        title: input.title,
        body: input.body,
        pinned: input.pinned,
        tags: input.tags,
        authorId: actor.id!,
        projectId: input.projectId ?? null,
        locationId: input.locationId ?? null,
      },
    });
    await audit({
      action: "NoteCreated",
      entityType: "note",
      entityId: note.id,
      data: {
        title: note.title,
        tags: note.tags,
        pinned: note.pinned,
        projectId: note.projectId,
        locationId: note.locationId,
      },
    });
    return note;
  });
}

export async function updateNote(
  actor: AuditActor,
  id: string,
  input: NoteCreateInput,
  expectedVersion: number,
): Promise<Note> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.note.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("work.err.note.notFound"));
    if (before.version !== expectedVersion) throw new NoteConflictError(before);
    await validateRefs(tx, input);

    const changed: string[] = [];
    if (input.title !== before.title) changed.push("title");
    if (input.body !== before.body) changed.push("body");
    if (input.pinned !== before.pinned) changed.push("pinned");
    if (!sameTags(input.tags, before.tags)) changed.push("tags");
    if ((input.projectId ?? null) !== before.projectId) changed.push("projectId");
    if ((input.locationId ?? null) !== before.locationId) changed.push("locationId");
    if (changed.length === 0) return before; // autosave no-op: no write, no audit

    // The version in the WHERE is the real guard: the read above can race a
    // concurrent save, but this row-locked compare-and-set cannot.
    const { count } = await tx.note.updateMany({
      where: { id, version: expectedVersion },
      data: {
        title: input.title,
        body: input.body,
        pinned: input.pinned,
        tags: input.tags,
        projectId: input.projectId ?? null,
        locationId: input.locationId ?? null,
        version: { increment: 1 },
      },
    });
    if (count === 0) {
      const current = await tx.note.findUnique({ where: { id } });
      if (!current) throw new NotFoundError(tr("work.err.note.notFound"));
      throw new NoteConflictError(current);
    }
    const note = await tx.note.findUniqueOrThrow({ where: { id } });
    await audit({
      action: "NoteUpdated",
      entityType: "note",
      entityId: id,
      // Field NAMES only — the body itself must not land in the append-only
      // log (an autosave diff of prose would be both noise and a data leak).
      data: { fields: changed },
    });
    return note;
  });
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export async function setNotePinned(actor: AuditActor, id: string, pinned: boolean): Promise<Note> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.note.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("work.err.note.notFound"));
    if (before.pinned === pinned) return before;
    const note = await tx.note.update({ where: { id }, data: { pinned } });
    await audit({
      action: pinned ? "NotePinned" : "NoteUnpinned",
      entityType: "note",
      entityId: id,
      data: { title: note.title },
    });
    return note;
  });
}

async function setArchived(actor: AuditActor, id: string, archived: boolean): Promise<Note> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.note.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("work.err.note.notFound"));
    if (archived && before.archivedAt)
      throw new ValidationError({}, [tr("work.err.note.alreadyArchived")]);
    if (!archived && !before.archivedAt)
      throw new ValidationError({}, [tr("work.err.note.notArchived")]);
    const note = await tx.note.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await audit({
      action: archived ? "NoteArchived" : "NoteUnarchived",
      entityType: "note",
      entityId: id,
      data: { title: note.title },
    });
    return note;
  });
}

export function archiveNote(actor: AuditActor, id: string): Promise<Note> {
  return setArchived(actor, id, true);
}

export function unarchiveNote(actor: AuditActor, id: string): Promise<Note> {
  return setArchived(actor, id, false);
}

/** Delete keeps the title in the audit row — the row is the only witness left. */
export async function deleteNote(actor: AuditActor, id: string): Promise<Note> {
  return txWithAudit(actor, async (tx, audit) => {
    const note = await tx.note.findUnique({ where: { id } });
    if (!note) throw new NotFoundError(tr("work.err.note.notFound"));
    const deleted = await tx.note.delete({ where: { id } });
    await audit({
      action: "NoteDeleted",
      entityType: "note",
      entityId: id,
      data: { title: note.title, pinned: note.pinned },
    });
    return deleted;
  });
}

/**
 * In-tx variants for the markdown importer: same writes, the audit verb
 * is the import's own. Exposed as `*InTx` like the tickets domain does.
 */
export async function createNoteInTx(
  tx: Tx,
  audit: AuditFn,
  actor: AuditActor,
  input: NoteCreateInput & { id?: string },
): Promise<Note> {
  if (!actor?.id) throw new ValidationError({}, [tr("work.err.note.authorRequired")]);
  await validateRefs(tx, input);
  const note = await tx.note.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      body: input.body,
      pinned: input.pinned,
      tags: input.tags,
      authorId: actor.id,
      projectId: input.projectId ?? null,
      locationId: input.locationId ?? null,
    },
  });
  await audit({
    action: "NoteImported",
    entityType: "note",
    entityId: note.id,
    data: { title: note.title, updated: false },
  });
  return note;
}

export async function updateNoteInTx(
  tx: Tx,
  audit: AuditFn,
  id: string,
  input: NoteCreateInput,
): Promise<Note> {
  await validateRefs(tx, input);
  const note = await tx.note.update({
    where: { id },
    data: {
      title: input.title,
      body: input.body,
      pinned: input.pinned,
      tags: input.tags,
      projectId: input.projectId ?? null,
      locationId: input.locationId ?? null,
      version: { increment: 1 },
    },
  });
  await audit({
    action: "NoteImported",
    entityType: "note",
    entityId: id,
    data: { title: note.title, updated: true },
  });
  return note;
}
