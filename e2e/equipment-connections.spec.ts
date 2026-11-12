import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const ids: string[] = [];
test.afterAll(async () => {
  await db.equipmentConnection.deleteMany({
    where: { ends: { some: { equipmentId: { in: ids } } } },
  });
  await db.equipment.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
for (const locale of ["de", "en"] as const) {
  for (const density of ["comfortable", "compact"]) {
    test(`connect, trace and disconnect equipment in ${locale}, ${density}`, async ({
      page,
      baseURL,
    }) => {
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 800 });
      const prefix = `${runPrefix()}wiring-${locale}-${density}`;
      const source = await db.equipment.create({
        data: {
          name: `${prefix} PC`,
          category: "PC",
          mobility: "POOLED",
          ports: {
            create: {
              label: "HDMI OUT",
              connector: "HDMI",
              direction: "OUTPUT",
              signal: "VIDEO",
              position: 0,
            },
          },
        },
        include: { ports: true },
      });
      const target = await db.equipment.create({
        data: {
          name: `${prefix} Projector`,
          category: "PROJECTOR",
          mobility: "POOLED",
          ports: {
            create: {
              label: "HDMI 1",
              connector: "HDMI",
              direction: "INPUT",
              signal: "VIDEO",
              position: 0,
            },
          },
        },
        include: { ports: true },
      });
      const empty = await db.equipment.create({
        data: { name: `${prefix} Display`, category: "OTHER", mobility: "POOLED" },
      });
      ids.push(source.id, target.id, empty.id);
      await page.goto(`/inventory/${source.id}`);
      const ports = page.getByRole("region", { name: t(locale, "ports.heading") });
      await ports
        .getByRole("button", {
          name: t(locale, "ports.connectPort", { label: "HDMI OUT" }),
          exact: true,
        })
        .click();
      const picker = page.locator(`#connect-${source.ports[0].id}`);
      await picker
        .getByRole("searchbox", { name: t(locale, "ports.searchDevices"), exact: true })
        .fill(prefix);
      await picker.getByRole("button", { name: t(locale, "ports.search"), exact: true }).click();
      const devices = picker.getByRole("combobox", {
        name: t(locale, "ports.targetDevice"),
        exact: true,
      });
      await expect(devices.locator(`option[value="${target.id}"]`)).toHaveCount(1);
      await devices.selectOption(target.id);
      const freePorts = picker.getByRole("combobox", {
        name: t(locale, "ports.targetPort"),
        exact: true,
      });
      await expect(freePorts.locator(`option[value="${target.ports[0].id}"]`)).toHaveCount(1);
      await freePorts.selectOption(target.ports[0].id);
      await picker
        .getByRole("textbox", { name: t(locale, "ports.connectionNote"), exact: true })
        .fill("Synthetic cable route A");
      await picker.getByRole("button", { name: t(locale, "ports.connect"), exact: true }).click();
      await expect(ports.getByRole("link", { name: target.name!, exact: true })).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await ports
        .getByRole("button", {
          name: t(locale, "ports.removePort", { label: "HDMI OUT" }),
          exact: true,
        })
        .click();
      await expect(ports.getByRole("alert")).toContainText(target.name!);
      await expect(ports.getByRole("link", { name: "HDMI 1", exact: true })).toHaveAttribute(
        "href",
        `/inventory/${target.id}#port-${target.ports[0].id}`,
      );
      await ports.getByRole("link", { name: "HDMI 1", exact: true }).click();
      await expect(page.getByRole("link", { name: source.name!, exact: true })).toBeVisible();
      await db.equipment.update({ where: { id: target.id }, data: { status: "RETIRED" } });
      await page.goto(`/inventory/${source.id}`);
      await expect(ports.getByText(t(locale, "ports.retired"), { exact: true })).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await ports
        .getByRole("button", {
          name: t(locale, "ports.disconnectPort", { label: "HDMI OUT" }),
          exact: true,
        })
        .click();
      await expect(
        ports.getByRole("button", {
          name: t(locale, "ports.connectPort", { label: "HDMI OUT" }),
          exact: true,
        }),
      ).toBeVisible();
      await ports
        .getByRole("button", {
          name: t(locale, "ports.connectPort", { label: "HDMI OUT" }),
          exact: true,
        })
        .click();
      await expect(devices.locator(`option[value="${empty.id}"]`)).toHaveCount(1);
      await devices.selectOption(empty.id);
      await expect(picker.getByText(t(locale, "ports.noFree"), { exact: true })).toBeVisible();
      await picker
        .getByRole("button", { name: t(locale, "ports.createThere"), exact: true })
        .click();
      await picker
        .getByRole("textbox", { name: t(locale, "ports.label"), exact: true })
        .fill("HDMI IN");
      await picker.getByRole("button", { name: t(locale, "ports.connect"), exact: true }).click();
      await expect(ports.getByRole("link", { name: empty.name!, exact: true })).toBeVisible();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1280);
      await ports.getByRole("link", { name: empty.name!, exact: true }).click();
      await expect(page.getByRole("link", { name: source.name!, exact: true })).toBeVisible();
    });
  }
}
