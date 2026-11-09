import type { Tx } from "~/lib/db.server";
import type { AuditActor, AuditFn } from "~/lib/audit.server";
import { tr } from "~/i18n/request-locale.server";
import { ValidationError } from "~/lib/errors.server";
import type { TransferProject } from "~/domains/transfer/transfer.schema";
import { PROJECT_RESTORE_AUDIT } from "./projects.transitions";

/**
 * In-transaction project upserts for the workspace import: the owning domain
 * writes its own model. Runs inside the caller's `txWithAudit`;
 * every refusal is prefixed with the 1-based row index so it is findable in a
 * large file.
 *
 * Two passes: all rows are upserted with `parentProjectId` left untouched,
 * then parents are linked — a parent may itself be imported in the same file,
 * and a single pass would depend on file order.
 */
export async function importProjectsInTx(
  tx: Tx,
  audit: AuditFn,
  actor: AuditActor,
  rows: TransferProject[],
): Promise<void> {
  const errors: string[] = [];

  // In-file duplicates and unresolved leads are collected for the whole file —
  // an import that stops at the first bad row makes the operator fix-and-retry
  // one error at a time.
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  const leadByRow = new Map<string, string | null>();

  for (const [i, p] of rows.entries()) {
    const n = tr("work.err.import.projectLabel", { index: i + 1, slug: p.slug });
    if (seenIds.has(p.id)) errors.push(`${n}: ${tr("work.err.import.duplicateId")}`);
    if (seenSlugs.has(p.slug)) errors.push(`${n}: ${tr("work.err.import.duplicateSlug")}`);
    seenIds.add(p.id);
    seenSlugs.add(p.slug);

    if (p.leadEmail) {
      const u = await tx.user.findUnique({
        where: { email: p.leadEmail.toLowerCase() },
        select: { id: true },
      });
      if (!u)
        errors.push(`${n}: ${tr("work.err.import.leadEmailUnknown", { email: p.leadEmail })}`);
      else leadByRow.set(p.id, u.id);
    } else {
      leadByRow.set(p.id, null);
    }

    const bySlug = await tx.project.findUnique({ where: { slug: p.slug }, select: { id: true } });
    if (bySlug && bySlug.id !== p.id) {
      errors.push(`${n}: ${tr("work.err.import.slugTaken", { slug: p.slug })}`);
    }
    if (p.parentSlug === p.slug) {
      errors.push(`${n}: ${tr("work.err.import.selfParentProject")}`);
    }
  }
  if (errors.length > 0) throw new ValidationError({}, errors);

  for (const p of rows) {
    const data = {
      slug: p.slug,
      name: p.name,
      description: p.description,
      status: p.status,
      color: p.color,
      startAt: p.startAt,
      dueAt: p.dueAt,
      leadId: leadByRow.get(p.id) ?? null,
    };
    const before = await tx.project.findUnique({ where: { id: p.id }, select: { id: true } });
    const project = before
      ? await tx.project.update({ where: { id: p.id }, data })
      : await tx.project.create({ data: { ...data, id: p.id, createdById: actor.id } });
    await audit({
      action: before ? PROJECT_RESTORE_AUDIT.update : PROJECT_RESTORE_AUDIT.create,
      entityType: "project",
      entityId: project.id,
      data: { name: project.name, slug: project.slug, viaImport: true },
    });
  }

  // Parent links — every slug resolves NOW (imported or pre-existing), and a
  // missing one is a row error that rolls the whole import back.
  const linkErrors: string[] = [];
  for (const [i, p] of rows.entries()) {
    if (!p.parentSlug) continue;
    const parent = await tx.project.findUnique({
      where: { slug: p.parentSlug },
      select: { id: true },
    });
    if (!parent) {
      linkErrors.push(
        `${tr("work.err.import.projectLabel", { index: i + 1, slug: p.slug })}: ${tr("work.err.import.parentSlugUnknown", { slug: p.parentSlug })}`,
      );
      continue;
    }
    await tx.project.update({ where: { id: p.id }, data: { parentProjectId: parent.id } });
  }
  if (linkErrors.length > 0) throw new ValidationError({}, linkErrors);
}
