import { expect, test } from "@playwright/test";

test("account email switches save and persist per notification type", async ({ page }) => {
  await page.goto("/account");
  const section = page.getByRole("region", { name: "E-Mail-Benachrichtigungen" });
  const switches = section.getByRole("switch");
  await expect(switches).toHaveCount(4);
  for (const control of await switches.all()) await expect(control).toBeChecked();

  const assignments = section.getByRole("switch", { name: "Aufgabenzuweisungen" });
  const save = section.getByRole("button", { name: "E-Mail-Einstellungen speichern" });
  await assignments.focus();
  await page.keyboard.press("Space");
  await expect(assignments).not.toBeChecked();
  await save.click();
  await expect(section.getByRole("status")).toHaveText("E-Mail-Einstellungen gespeichert.");

  await page.reload();
  await expect(assignments).not.toBeChecked();
  await expect(section.getByRole("switch", { name: "Buchungskonflikte" })).toBeChecked();
  await assignments.click();
  await save.click();
  await expect(section.getByRole("status")).toHaveText("E-Mail-Einstellungen gespeichert.");
});
