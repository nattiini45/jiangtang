import { test, expect, type Locator, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { createProject } from "~/domains/projects/projects.mutations.server";
import { createTask } from "~/domains/tasks/tasks.mutations.server";
import { raiseTicketFromTask } from "~/domains/tasks/tasks.harmony.server";
import { runPrefix } from "./run";

async function drop(page: Page, handle: Locator, lane: Locator) {
  await handle.hover();
  await page.mouse.down();
  const box = (await lane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 30, { steps: 12 });
  await page.mouse.up();
}

test.afterAll(async () => {
  await db.$disconnect();
});

test("ticket board drops enforce legal actions and collect resolution before writing", async ({
  page,
}) => {
  const admin = await db.user.findFirstOrThrow({ where: { email: process.env.ADMIN_EMAIL } });
  const actor = { id: admin.id, name: admin.name };
  const project = await createProject(actor, {
    name: `${runPrefix()}ticket workflow`,
    status: "CONFIRMED",
  });
  const task = await createTask(actor, {
    title: `${runPrefix()}linked work`,
    status: "BACKLOG",
    labels: [],
    projectId: project.id,
  });
  const { ticket } = await raiseTicketFromTask(actor, task.id, {
    type: "INCIDENT",
    title: `${runPrefix()}ticket drop`,
  });
  const auditCount = () =>
    db.activityLog.count({ where: { entityType: "ticket", entityId: ticket.id } });
  const lane = (label: string) => page.locator(`[aria-label="${label}"]`);
  const handle = page.getByRole("button", { name: `Ticket „${ticket.title}“` });
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/board")) posts.push(request.url());
  });
  try {
    await page.goto(`/board?mode=work&project=${project.slug}`);
    await page.locator("html[data-hydrated]").waitFor();
    const before = await auditCount();
    await drop(page, handle, lane("Review / Blockiert"));
    await expect(page.getByRole("alert")).toContainText("Verfügbare Aktionen");
    expect(posts).toHaveLength(0);
    expect(await auditCount()).toBe(before);

    await drop(page, handle, lane("Erledigt"));
    const dialog = page.getByRole("dialog");
    const resolution = dialog.getByRole("textbox", { name: "Lösung" });
    await expect(dialog).toBeVisible();
    await expect(resolution).toBeFocused();
    await dialog.getByRole("button", { name: "Lösen", exact: true }).click();
    expect(posts).toHaveLength(0);
    expect(await auditCount()).toBe(before);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    await drop(page, handle, lane("Erledigt"));
    await resolution.fill("   ");
    await dialog.getByRole("button", { name: "Lösen", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Lösung angeben.");
    await expect(resolution).toHaveValue("   ");
    expect(await auditCount()).toBe(before);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("OPEN");

    await expect(dialog.getByRole("button", { name: "Lösen", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await drop(page, handle, lane("Erledigt"));
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await resolution.fill("Synthetic browser repair");
    await dialog.getByRole("button", { name: "Lösen", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      lane("Erledigt").getByRole("link", { name: ticket.title, exact: true }),
    ).toBeVisible();
    expect(await auditCount()).toBe(before + 1);
    expect(await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      status: "RESOLVED",
      resolution: "Synthetic browser repair",
    });

    const count = posts.length;
    await drop(page, handle, lane("Erledigt"));
    expect(posts).toHaveLength(count);
    expect(await auditCount()).toBe(before + 1);
    await page.reload();
    await page.locator("html[data-hydrated]").waitFor();
    await page.getByRole("button", { name: /Abgebrochene anzeigen/ }).click();
    await lane("Abgebrochen").scrollIntoViewIfNeeded();
    await drop(page, handle, lane("Abgebrochen"));
    await expect(page.getByRole("alert")).toContainText("Verfügbare Aktionen");
    expect(posts).toHaveLength(count);
    expect(await auditCount()).toBe(before + 1);
    await lane("In Arbeit").scrollIntoViewIfNeeded();
    await drop(page, handle, lane("In Arbeit"));
    await expect(
      lane("In Arbeit").getByRole("link", { name: ticket.title, exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status)
      .toBe("IN_PROGRESS");
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).resolution).toBeNull();
  } finally {
    await db.ticket.delete({ where: { id: ticket.id } });
  }
});
