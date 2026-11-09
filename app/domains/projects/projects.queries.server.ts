import { tr } from "~/i18n/request-locale.server";
import { Prisma } from "~/generated/prisma/client";
import type { ProjectStatus } from "~/generated/prisma/enums";
import { db, type Tx } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import type { ProjectListOptions } from "./projects.schema";

/**
 * Projects-domain queries. Single-row reads, the list with its
 * task counts, and the reference counts / subtree probe the mutations need.
 *
 * Nothing here writes, so no transaction is opened — every mutating caller
 * opens its own through `txWithAudit`.
 */

/** Task progress split for a project row: DONE is done, CANCELLED is settled
 *  but not done, everything else is open. */
export interface ProjectTaskCounts {
  total: number;
  open: number;
  done: number;
}

const PROJECT_LEAD = { select: { id: true, name: true, initials: true } } as const;

export interface ProjectListRow {
  id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  color: string | null;
  startAt: Date | null;
  dueAt: Date | null;
  lead: { id: string; name: string; initials: string | null } | null;
  tasks: ProjectTaskCounts;
}

/**
 * The project list with its per-project task progress. Counts come from one
 * `groupBy` on `(projectId, status)` — never per-row queries — and `open`
 * counts every status that is neither DONE nor CANCELLED.
 */
export async function listProjects(
  options: ProjectListOptions = {},
  page: { offset?: number; limit?: number } = {},
): Promise<ProjectListRow[]> {
  const where = {
    ...(options.status ? { status: options.status } : {}),
    ...(options.leadId ? { leadId: options.leadId } : {}),
    ...(options.q ? { name: { contains: options.q, mode: "insensitive" as const } } : {}),
  };

  const [projects, grouped] = await Promise.all([
    db.project.findMany({
      skip: page.offset,
      take: page.limit,
      where,
      include: { lead: PROJECT_LEAD },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    db.task.groupBy({
      by: ["projectId", "status"],
      _count: { _all: true },
      where: { projectId: { not: null } },
    }),
  ]);

  const counts = new Map<string, ProjectTaskCounts>();
  for (const row of grouped) {
    const c = counts.get(row.projectId!) ?? { total: 0, open: 0, done: 0 };
    c.total += row._count._all;
    if (row.status === "DONE") c.done += row._count._all;
    else if (row.status !== "CANCELLED") c.open += row._count._all;
    counts.set(row.projectId!, c);
  }

  return projects.map((p) => ({
    ...p,
    tasks: counts.get(p.id) ?? { total: 0, open: 0, done: 0 },
  }));
}

/** Picker rows: everything a `<select>` needs and nothing more. */
export async function listProjectOptions(): Promise<
  Array<{ id: string; name: string; slug: string }>
> {
  return db.project.findMany({
    select: { id: true, name: true, slug: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/** One project by its URL slug, or `null`. */
export async function getProjectBySlug(slug: string) {
  return db.project.findUnique({
    where: { slug },
    include: {
      lead: PROJECT_LEAD,
      parentProject: { select: { id: true, name: true, slug: true } },
      subProjects: {
        select: { id: true, name: true, slug: true, status: true },
        orderBy: { name: "asc" },
      },
      tasks: {
        select: {
          id: true,
          title: true,
          status: true,
          startAt: true,
          dueAt: true,
          estimateMinutes: true,
          position: true,
          parentTaskId: true,
          createdAt: true,
          // `blockedBy` rows name the blocker in `blockingTaskId` — the gantt
          // draws its arrows blocker→blocked from exactly these ids.
          blockedBy: { select: { blockingTaskId: true } },
        },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      },
    },
  });
}

/** Like {@link getProjectBySlug} but throws — for routes that 404 without it. */
export async function requireProjectBySlug(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new NotFoundError(tr("work.err.project.notFound"));
  return project;
}

/** The plain row by id — the mutation path's handle, no relations. */
export async function getProject(id: string) {
  return db.project.findUnique({ where: { id } });
}

export interface ProjectReferenceCounts {
  /** Direct sub-projects — the self-reference. `Restrict`, so a hard block. */
  subProjects: number;
  /** Inbound `SetNull` references: detached on delete, not blocked. */
  tasks: number;
  events: number;
  notes: number;
}

export const EMPTY_PROJECT_REFERENCE_COUNTS: ProjectReferenceCounts = {
  subProjects: 0,
  tasks: 0,
  events: 0,
  notes: 0,
};

/**
 * How many rows point at this project, counted on the given transaction.
 * `subProjects` is what `deleteProject` refuses on; the other three are
 * `SetNull` — counted and recorded, not blocked (the `countLocationReferences`
 * contract, one folder over).
 */
export async function countProjectReferences(tx: Tx, id: string): Promise<ProjectReferenceCounts> {
  const [subProjects, tasks, events, notes] = await Promise.all([
    tx.project.count({ where: { parentProjectId: id } }),
    tx.task.count({ where: { projectId: id } }),
    tx.event.count({ where: { projectId: id } }),
    tx.note.count({ where: { projectId: id } }),
  ]);
  return { subProjects, tasks, events, notes };
}

export function totalProjectReferences(counts: ProjectReferenceCounts): number {
  return counts.subProjects + counts.tasks + counts.events + counts.notes;
}

/**
 * Is `candidateId` somewhere STRICTLY below `ancestorId` in the project tree?
 * The `isDescendantWithin` walk pointed at `Project.parentProjectId` — used by
 * `updateProject`'s reparent refusal, on the caller's transaction so it sees
 * the same snapshot. Bounded by `hops` against a hierarchy that already loops.
 */
export async function isProjectDescendantWithin(
  tx: Tx,
  ancestorId: string,
  candidateId: string,
  maxHops = 100,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ found: boolean }>>(Prisma.sql`
    WITH RECURSIVE up AS (
      SELECT id, "parentProjectId", 0::int AS hops
      FROM "Project"
      WHERE id = ${candidateId}
      UNION ALL
      SELECT parent.id, parent."parentProjectId", child.hops + 1
      FROM "Project" parent
      JOIN up child ON child."parentProjectId" = parent.id
      WHERE child.hops < ${maxHops}
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE id = ${ancestorId} AND hops > 0) AS found
  `);
  return rows[0]?.found === true;
}
