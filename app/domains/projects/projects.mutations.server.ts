import { tr } from "~/i18n/request-locale.server";
import { NotFoundError, ValidationError, hasSqlState } from "~/lib/errors.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { ensureUniqueSlug } from "~/lib/slug.server";
import { type Tx } from "~/lib/db.server";
import type { Project, ProjectStatus } from "~/generated/prisma/client";
import type { ProjectCreateInput, ProjectEditInput } from "./projects.schema";
import {
  countProjectReferences,
  isProjectDescendantWithin,
  totalProjectReferences,
} from "./projects.queries.server";

/**
 * Projects-domain mutations. Every one of them runs through
 * `txWithAudit`, so the `ActivityLog` row commits with the change or not at all —
 * the append-only audit spine, and the thing `guards.sh` #2 protects.
 *
 * **A refused mutation writes nothing — not the change, and not an audit row**.
 * The refusals:
 *
 * - deleting a project that still has sub-projects (`Restrict`; the child count
 *   is named in the message, and the check is the *handler* — `Restrict` is the
 *   backstop that catches a racing delete, and a raw `23001` is never allowed
 *   to reach a caller);
 * - reparenting a project under itself or under one of its own descendants
 *   (the `moveLocation` shape applied to `parentProjectId`);
 * - a status change to the status the project already has;
 * - touching a project that does not exist.
 *
 * **`slug` is not editable.** It is derived from the name once, at create, via
 * `ensureUniqueSlug` — and then never rewritten, because a slug that followed
 * renames would break every link ever shared.
 */

/** Postgres `restrict_violation` — the SQLSTATE a `Restrict` FK raises. */
const SQLSTATE_RESTRICT_VIOLATION = "23001";

/** A project id that is not a real row. Checked before anything is written. */
async function requireProject(tx: Tx, id: string, field = "parentProjectId"): Promise<Project> {
  const project = await tx.project.findUnique({ where: { id } });
  if (!project) throw new ValidationError({ [field]: [tr("work.err.project.unknown")] });
  return project;
}

export async function createProject(
  actor: AuditActor,
  input: ProjectCreateInput,
): Promise<Project> {
  return txWithAudit(actor, async (tx, audit) => {
    if (input.parentProjectId) await requireProject(tx, input.parentProjectId);
    if (input.leadId) {
      const lead = await tx.user.findUnique({ where: { id: input.leadId }, select: { id: true } });
      if (!lead) throw new ValidationError({ leadId: [tr("work.err.unknownUser")] });
    }
    const slug = await ensureUniqueSlug(input.name, async (candidate) => {
      return (
        (await tx.project.findUnique({ where: { slug: candidate }, select: { id: true } })) !== null
      );
    });
    const project = await tx.project.create({
      data: {
        name: input.name,
        slug,
        description: input.description ?? null,
        status: input.status,
        color: input.color ?? null,
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        leadId: input.leadId ?? null,
        parentProjectId: input.parentProjectId ?? null,
        createdById: actor?.id ?? null,
      },
    });
    await audit({
      action: "ProjectCreated",
      entityType: "project",
      entityId: project.id,
      data: { name: project.name, slug: project.slug, status: project.status },
    });
    return project;
  });
}

/**
 * Content + reparent in one write. `status` is deliberately not a field here
 * (`setProjectStatus` owns it); the `parentProjectId` cycle refusal is the same
 * shape `moveLocation` gives `Location.parentId`.
 */
export async function updateProject(
  actor: AuditActor,
  id: string,
  input: ProjectEditInput,
): Promise<Project> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.project.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("work.err.project.notFound"));

    const parentProjectId = input.parentProjectId ?? null;
    if (parentProjectId) {
      if (parentProjectId === id) {
        throw new ValidationError({
          parentProjectId: [tr("work.err.project.selfParent")],
        });
      }
      const parent = await requireProject(tx, parentProjectId);
      if (await isProjectDescendantWithin(tx, id, parentProjectId)) {
        throw new ValidationError({
          parentProjectId: [
            tr("work.err.project.parentInSubtree", {
              parentName: parent.name,
              name: before.name,
            }),
          ],
        });
      }
    }
    if (input.leadId) {
      const lead = await tx.user.findUnique({ where: { id: input.leadId }, select: { id: true } });
      if (!lead) throw new ValidationError({ leadId: [tr("work.err.unknownUser")] });
    }

    const project = await tx.project.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? null,
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        leadId: input.leadId ?? null,
        parentProjectId,
      },
    });
    await audit({
      action: "ProjectUpdated",
      entityType: "project",
      entityId: project.id,
      data: {
        from: {
          name: before.name !== project.name ? before.name : undefined,
          description: before.description !== project.description ? before.description : undefined,
          color: before.color !== project.color ? before.color : undefined,
          parentProjectId:
            before.parentProjectId !== project.parentProjectId ? before.parentProjectId : undefined,
        },
        to: { name: project.name, parentProjectId: project.parentProjectId },
      },
    });
    return project;
  });
}

/**
 * A lifecycle transition, audited as its own event (`ProjectStatusChanged
 * {from,to}`) — never folded into `ProjectUpdated`, which is why the edit
 * schema does not carry `status`.
 */
export async function setProjectStatus(
  actor: AuditActor,
  id: string,
  status: ProjectStatus,
): Promise<Project> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.project.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("work.err.project.notFound"));
    if (before.status === status) {
      throw new ValidationError({ status: [tr("work.err.project.statusAlready")] });
    }
    const project = await tx.project.update({ where: { id }, data: { status } });
    await audit({
      action: "ProjectStatusChanged",
      entityType: "project",
      entityId: id,
      data: { name: project.name, from: before.status, to: status },
    });
    return project;
  });
}

/**
 * Delete a project. Refused while it has sub-projects (`Restrict`; the
 * child count is named in the message). Tasks, events and notes detach via
 * `SetNull` — their counts go into the audit row, because a delete that
 * silently strips a project container off 40 tasks is not something the
 * append-only log should be the only witness of.
 */
export async function deleteProject(actor: AuditActor, id: string): Promise<Project> {
  return txWithAudit(actor, async (tx, audit) => {
    const project = await tx.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundError(tr("work.err.project.notFound"));

    const counts = await countProjectReferences(tx, id);
    if (counts.subProjects > 0) {
      throw new ValidationError({}, [
        tr(
          counts.subProjects === 1
            ? "work.err.project.deleteWithSubprojects.one"
            : "work.err.project.deleteWithSubprojects.other",
          { name: project.name, count: counts.subProjects },
        ),
      ]);
    }

    const detached = totalProjectReferences(counts);
    let deleted: Project;
    try {
      deleted = await tx.project.delete({ where: { id } });
    } catch (error) {
      // Backstop for the race the count cannot close: another writer can attach
      // a child between the COUNT and the DELETE. The violation carries SQLSTATE `23001`
      // on the adapter cause, which `hasSqlState` reads.
      if (hasSqlState(error, SQLSTATE_RESTRICT_VIOLATION)) {
        throw new ValidationError({}, [
          tr("work.err.project.subprojectsSinceCheck", { name: project.name }),
        ]);
      }
      throw error;
    }
    await audit({
      action: "ProjectDeleted",
      entityType: "project",
      entityId: id,
      data: {
        name: project.name,
        detached: { ...counts, subProjects: 0 },
        detachedTotal: detached,
      },
    });
    return deleted;
  });
}
