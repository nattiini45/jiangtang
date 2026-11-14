import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { runPrefix } from "./run";

let equipmentId: string;

test.beforeAll(async () => {
  equipmentId = `${runPrefix()}calendar-navigation`;
  await db.equipment.create({
    data: { id: equipmentId, name: equipmentId, category: "PROJECTOR", mobility: "POOLED" },
  });
});

test.afterAll(async () => {
  if (equipmentId) await db.equipment.deleteMany({ where: { id: equipmentId } });
});

for (const [view, label, nextDate] of [
  ["month", "Monat", "2026-12-01"],
  ["week", "Woche", "2026-11-15"],
  ["day", "Tag", "2026-11-09"],
  ["rooms", "Räume", "2026-11-09"],
] as const) {
  test(`pending ${view} navigation preserves the latest date and filters`, async ({ page }) => {
    await page.goto(
      `/calendar?view=${view === "week" ? "day" : "week"}&date=2026-11-08&status=CONFIRMED&room=seed_room_a01&equipment=${equipmentId}`,
    );
    await expect(page.locator("html[data-hydrated]")).toBeAttached();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/calendar.data?**", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page
        .getByRole("navigation", { name: "Kalenderansichten" })
        .getByRole("link", { name: label, exact: true })
        .click();
      await expect(page.locator('main input[name="view"]')).toHaveValue(view);
      await page.getByText("Anzeigen (6)", { exact: true }).click();
      await page.getByRole("checkbox", { name: "Aufgaben", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "Aufgaben", exact: true }).check();
      const nextRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === "/calendar.data" && url.searchParams.get("date") === nextDate;
      });
      await page.getByRole("link", { name: "Nächster Zeitraum" }).click();
      const request = await nextRequest;
      const params = new URL(request.url()).searchParams;
      expect(params.get("view")).toBe(view);
      expect(params.get("kinds")).toBe("events,service,tasks,projects,dates,plans");
      expect(params.get("status")).toBe("CONFIRMED");
      expect(params.get("room")).toBe("seed_room_a01");
      expect(params.get("equipment")).toBe(equipmentId);
      await expect(page.locator('input[name="date"]')).toHaveValue(nextDate);
      await page.getByRole("checkbox", { name: "Aufgaben", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "Aufgaben", exact: true }).check();
    } finally {
      release();
    }
    await expect(
      page.getByRole("main").getByRole("link", { name: label, exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(new RegExp(`date=${nextDate}`));
    await expect(page).toHaveURL(/kinds=events%2Cservice%2Ctasks%2Cprojects%2Cdates/);
  });
}
