import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { TaskStatus, ProjectStatus } from "~/generated/prisma/enums";
import { createTask } from "~/domains/tasks/tasks.mutations.server";
import { createProject } from "~/domains/projects/projects.mutations.server";
import { taskActionMetadata } from "~/domains/tasks/tasks.transitions";
import { projectActionMetadata } from "~/domains/projects/projects.transitions";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";

vi.mock("~/lib/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth.server")>()),
  requireUser: vi.fn(async () => ({
    id: "synthetic-work-route-member",
    name: "Synthetic work route member",
    role: "MEMBER",
  })),
}));
const desktop = await import("~/routes/_desktop.tasks.$id/route");
const mobile = await import("~/routes/m.tasks.$id/route");
const projects = await import("~/routes/_desktop.projects.$slug/route");
const board = await import("~/routes/_desktop.board/route");
const actor = { id: null, name: "Synthetic work route member" };
const taskIds: string[] = [];
const projectIds: string[] = [];
const request = (path: string, fields: Record<string, string>, locale = "en") =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Accept-Language": locale },
  });
afterAll(async () => {
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.$disconnect();
});

describe("work route allowed-action parity", () => {
  for (const status of Object.values(TaskStatus)) {
    it(`${status}: desktop and compact mobile load the same task policy`, async () => {
      const task = await createTask(actor, { title: "Synthetic route task", status, labels: [] });
      taskIds.push(task.id);
      for (const route of [desktop, mobile]) {
        const result = await route.loader({
          request: new Request(`http://localhost/tasks/${task.id}`),
          params: { id: task.id },
        } as never);
        expect(result.allowedActions).toEqual(taskActionMetadata(status).allowedActions);
        expect(result.task).toMatchObject(taskActionMetadata(status));
      }
    });
  }
  for (const status of Object.values(ProjectStatus)) {
    it(`${status}: desktop project detail projects every other status without a mobile editor`, async () => {
      const project = await createProject(actor, { name: "Synthetic route project", status });
      projectIds.push(project.id);
      const result = await projects.loader({
        request: new Request(`http://localhost/projects/${project.slug}`),
        params: { slug: project.slug },
      } as never);
      expect(result.allowedActions).toEqual(projectActionMetadata(status).allowedActions);
      expect(result.project).toMatchObject(projectActionMetadata(status));
    });
  }
  for (const locale of ["en", "de"] as const) {
    it(`${locale}: desktop, palette and mobile reject unchanged task status with identical current-state metadata and no audit`, async () => {
      const task = await createTask(actor, {
        title: "Synthetic route rejection",
        status: "TODO",
        labels: [],
      });
      taskIds.push(task.id);
      const prior = await db.activityLog.findMany({
        where: { entityType: "task", entityId: task.id },
      });
      const message = t(locale, "work.err.task.statusAlready");
      await runWithLocale(locale, async () => {
        for (const intent of ["status", "set-status"]) {
          const result = await desktop.action({
            request: request(`/tasks/${task.id}`, { _action: intent, status: "TODO" }, locale),
            params: { id: task.id },
          } as never);
          expect(result).toMatchObject({
            fieldErrors: { status: [message] },
            formErrors: [message],
            transition: {
              entity: "task",
              currentState: "TODO",
              attemptedTarget: "TODO",
              ...taskActionMetadata("TODO"),
              reason: { code: "INVALID_TRANSITION", message },
            },
          });
        }
        const response = await mobile
          .action({
            request: request(
              `/m/tasks/${task.id}`,
              { _action: "set-status", status: "TODO" },
              locale,
            ),
            params: { id: task.id },
          } as never)
          .catch((error: Response) => error);
        expect(response).toBeInstanceOf(Response);
        if (!(response instanceof Response)) throw new Error("Expected rejected mobile response");
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          transition: {
            entity: "task",
            currentState: "TODO",
            attemptedTarget: "TODO",
            ...taskActionMetadata("TODO"),
            reason: { code: "INVALID_TRANSITION", message },
          },
        });
      });
      expect(
        await db.activityLog.findMany({ where: { entityType: "task", entityId: task.id } }),
      ).toEqual(prior);
      expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
    });
    it(`${locale}: project status results and rejections preserve slug routing and next-action metadata`, async () => {
      const project = await createProject(actor, {
        name: "Synthetic route status",
        status: "REQUESTED",
      });
      projectIds.push(project.id);
      await runWithLocale(locale, async () => {
        const args = {
          request: request(
            `/projects/${project.slug}`,
            { _action: "status", status: "CONFIRMED" },
            locale,
          ),
          params: { slug: project.slug },
        };
        expect(await projects.action(args as never)).toMatchObject({
          status: "CONFIRMED",
          ...projectActionMetadata("CONFIRMED"),
        });
        const prior = await db.activityLog.findMany({
          where: { entityType: "project", entityId: project.id },
        });
        const rejected = await projects.action({
          ...args,
          request: request(
            `/projects/${project.slug}`,
            { _action: "status", status: "CONFIRMED" },
            locale,
          ),
        } as never);
        expect(rejected).toMatchObject({
          transition: {
            entity: "project",
            currentState: "CONFIRMED",
            attemptedTarget: "CONFIRMED",
            ...projectActionMetadata("CONFIRMED"),
            reason: {
              code: "INVALID_TRANSITION",
              message: t(locale, "work.err.project.statusAlready"),
            },
          },
        });
        expect(
          await db.activityLog.findMany({ where: { entityType: "project", entityId: project.id } }),
        ).toEqual(prior);
      });
    });
  }
  it("board move and mobile status success expose the same next status actions", async () => {
    const task = await createTask(actor, {
      title: "Synthetic route move",
      status: "TODO",
      labels: [],
    });
    taskIds.push(task.id);
    expect(
      await board.action({
        request: request("/board", { _action: "move", taskId: task.id, lane: "IN_REVIEW" }),
      } as never),
    ).toEqual({ ok: true, ...taskActionMetadata("IN_REVIEW") });
    expect(
      await mobile.action({
        request: request(`/m/tasks/${task.id}`, { _action: "set-status", status: "BLOCKED" }),
        params: { id: task.id },
      } as never),
    ).toEqual({ ok: true, ...taskActionMetadata("BLOCKED") });
  });
});
