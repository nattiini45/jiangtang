import { db } from "~/lib/db.server";
import { TRANSFER_FORMAT, TRANSFER_VERSION } from "./transfer.schema";

/**
 * Workspace export — the `jiangtang-workspace` v1 JSON document. Reads
 * only; the import half lives in `transfer.server.ts` and the per-model
 * upserts in each owning domain's `*.transfer.server.ts`. This file performs
 * no writes, so the `FOLDERS` entry for `app/domains/transfer` stays `[]`.
 *
 * References are emitted as the file's portable keys: lead → `leadEmail`,
 * parent project → `parentSlug`, task project → `projectSlug`, note project →
 * `projectSlug`, task assignees → `email` (+ share), blocker edges → the
 * BLOCKING task's id inside `blockedBy`. Enums export as their stored values;
 * dates as ISO instants.
 */
export async function exportWorkspace() {
  const [projects, tasks, notes] = await Promise.all([
    db.project.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        status: true,
        color: true,
        startAt: true,
        dueAt: true,
        lead: { select: { email: true } },
        parentProject: { select: { slug: true } },
      },
    }),
    db.task.findMany({
      select: {
        id: true,
        title: true,
        body: true,
        status: true,
        priority: true,
        startAt: true,
        dueAt: true,
        estimateMinutes: true,
        labels: true,
        project: { select: { slug: true } },
        parentTaskId: true,
        assignees: { select: { estimateMinutes: true, user: { select: { email: true } } } },
        blockedBy: { select: { blockingTaskId: true } },
      },
    }),
    db.note.findMany({
      select: {
        id: true,
        title: true,
        body: true,
        tags: true,
        pinned: true,
        project: { select: { slug: true } },
        locationId: true,
        archivedAt: true,
      },
    }),
  ]);

  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    projects: projects.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      status: p.status,
      color: p.color,
      startAt: iso(p.startAt),
      dueAt: iso(p.dueAt),
      leadEmail: p.lead?.email ?? null,
      parentSlug: p.parentProject?.slug ?? null,
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      body: t.body,
      status: t.status,
      priority: t.priority,
      startAt: iso(t.startAt),
      dueAt: iso(t.dueAt),
      estimateMinutes: t.estimateMinutes,
      labels: t.labels,
      projectSlug: t.project?.slug ?? null,
      parentTaskId: t.parentTaskId,
      assignees: t.assignees.map((a) => ({
        email: a.user.email,
        estimateMinutes: a.estimateMinutes,
      })),
      blockedBy: t.blockedBy.map((e) => e.blockingTaskId),
    })),
    notes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      tags: n.tags,
      pinned: n.pinned,
      projectSlug: n.project?.slug ?? null,
      locationId: n.locationId,
      archivedAt: iso(n.archivedAt),
    })),
  };
}
