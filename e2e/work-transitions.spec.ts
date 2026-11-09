import { test, expect } from "@playwright/test";
import { db } from "~/lib/db.server";
import { createTask, setTaskStatus } from "~/domains/tasks/tasks.mutations.server";
import { createProject } from "~/domains/projects/projects.mutations.server";
import { addTaskBlocker } from "~/domains/tasks/tasks.dependencies.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const taskIds: string[] = [];
const projectIds: string[] = [];
async function fixture() {
  const user = await db.user.findFirstOrThrow({ where: { email: process.env.ADMIN_EMAIL } });
  const actor = { id: user.id, name: user.name };
  const project = await createProject(actor, {
    name: `${runPrefix()}work lifecycle`,
    status: "COMPLETED",
  });
  projectIds.push(project.id);
  const task = await createTask(actor, {
    title: `${runPrefix()}work action`,
    status: "TODO",
    projectId: project.id,
    labels: [],
  });
  const blocker = await createTask(actor, {
    title: `${runPrefix()}unfinished blocker`,
    status: "BACKLOG",
    labels: [],
  });
  taskIds.push(task.id, blocker.id);
  await addTaskBlocker(actor, task.id, blocker.id);
  return { actor, task, project };
}
test.afterAll(async () => {
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.$disconnect();
});

for (const locale of ["en", "de"] as const) {
  test(`${locale}: desktop status forms disable unchanged submits and palette uses current task data`, async ({
    page,
    context,
    baseURL,
  }) => {
    const { task, project } = await fixture();
    await context.addCookies([{ name: "locale", value: locale, url: baseURL! }]);
    await page.goto(`/tasks/${task.id}`);
    await page.locator("html[data-hydrated]").waitFor();
    const status = page.getByRole("combobox", {
      name: t(locale, "tasks.detail.status.aria"),
      exact: true,
    });
    const submit = page.getByRole("button", {
      name: t(locale, "tasks.detail.status.submit"),
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAccessibleDescription(t(locale, "work.err.task.statusAlready"));
    await expect(status.locator("option:enabled")).toHaveCount(6);
    await status.selectOption("DONE");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(status).toHaveValue("DONE");
    await expect(submit).toBeDisabled();
    await expect
      .poll(async () => (await db.task.findUniqueOrThrow({ where: { id: task.id } })).status)
      .toBe("DONE");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: t(locale, "command.label") });
    await palette.getByRole("combobox").fill(locale === "en" ? "Set status" : "Status setzen");
    await expect(
      palette.getByRole("option", {
        name: new RegExp(
          `^${t(locale, "command.verb.setStatus", { status: t(locale, "status.task.DONE") })}`,
        ),
      }),
    ).toHaveCount(0);
    await expect(palette.getByRole("option", { name: /^(Set status|Status setzen):/ })).toHaveCount(
      6,
    );
    await page.keyboard.press("Escape");
    await page.goto(`/projects/${project.slug}`);
    await page.locator("html[data-hydrated]").waitFor();
    const projectStatus = page.getByRole("combobox", {
      name: t(locale, "projects.detail.statusAria"),
    });
    const projectSubmit = page.getByRole("button", {
      name: t(locale, "projects.detail.setStatus"),
      exact: true,
    });
    await expect(projectSubmit).toBeDisabled();
    await expect(projectSubmit).toHaveAccessibleDescription(
      t(locale, "work.err.project.statusAlready"),
    );
    await expect(projectStatus.locator("option:enabled")).toHaveCount(7);
    await projectStatus.selectOption("REQUESTED");
    await projectSubmit.click();
    await expect
      .poll(async () => (await db.project.findUniqueOrThrow({ where: { id: project.id } })).status)
      .toBe("REQUESTED");
    await expect(projectStatus).toHaveValue("REQUESTED");
    await expect(projectSubmit).toBeDisabled();
  });

  test(`${locale}: a stale task palette command surfaces the real server rejection`, async ({
    page,
    context,
    baseURL,
  }) => {
    const { actor, task } = await fixture();
    await context.addCookies([{ name: "locale", value: locale, url: baseURL! }]);
    await page.goto(`/tasks/${task.id}`);
    await page.locator("html[data-hydrated]").waitFor();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: t(locale, "command.label") });
    const command = t(locale, "command.verb.setStatus", {
      status: t(locale, "status.task.IN_PROGRESS"),
    });
    await palette.getByRole("combobox").fill(command);
    const before = await db.activityLog.count({ where: { entityType: "task", entityId: task.id } });
    await page.route(`**/tasks/${task.id}*`, async (route) => {
      if (route.request().method() === "POST") await setTaskStatus(actor, task.id, "IN_PROGRESS");
      await route.continue();
    });
    await palette.getByRole("option", { name: new RegExp(`^${command}`) }).click();
    await expect(palette).not.toBeVisible();
    await expect(page.getByRole("alert")).toContainText(t(locale, "work.err.task.statusAlready"));
    expect(await db.activityLog.count({ where: { entityType: "task", entityId: task.id } })).toBe(
      before + 1,
    );
    await page
      .getByRole("button", { name: t(locale, "command.dismissError"), exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test(`${locale}: mobile keeps its compact status subset and uses the shared current-state reason`, async ({
    page,
    context,
    baseURL,
  }) => {
    const { task } = await fixture();
    await context.addCookies([{ name: "locale", value: locale, url: baseURL! }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/m/tasks/${task.id}`);
    await page.locator("html[data-hydrated]").waitFor();
    const current = page.getByRole("button", { name: t(locale, "status.task.TODO"), exact: true });
    await expect(current).toBeDisabled();
    await expect(current).toHaveAccessibleDescription(t(locale, "work.err.task.statusAlready"));
    await expect(
      page.getByRole("button", { name: t(locale, "status.task.CANCELLED"), exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: t(locale, "status.task.BACKLOG"), exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: t(locale, "status.task.DONE"), exact: true }).click();
    await expect(
      page.getByRole("button", { name: t(locale, "status.task.DONE"), exact: true }),
    ).toBeDisabled();
    await expect
      .poll(async () => (await db.task.findUniqueOrThrow({ where: { id: task.id } })).status)
      .toBe("DONE");
    await page.goto("/m/projects");
    await expect(page.getByRole("combobox")).toHaveCount(0);
  });
}
