import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const rooms: string[] = [];
const problem =
  "Synthetic HDMI issue: the lectern input occasionally loses the picture when the connector is moved during a presentation.\nUse the second input until the cable is replaced. Leave the control panel on HDMI 2 and check the laptop output before restarting anything.\nKeep the spare adapter in the drawer for support calls. If the picture is still missing, disconnect and reconnect the cable at the laptop.";
const tips =
  "Synthetic operating notes: switch on the projector before connecting a laptop and wait until its startup screen has disappeared.\nSelect HDMI 2 on the control panel, then unmute the audio. Set the laptop volume halfway before adjusting the room volume.\nReturn the remote to the lectern drawer after the event and leave the spare adapter beside it. Switch off the projector using the control panel.";

test.afterAll(async () => {
  await db.equipment.deleteMany({ where: { roomId: { in: rooms } } });
  await db.room.deleteMany({ where: { id: { in: rooms } } });
  await db.$disconnect();
});

for (const locale of ["de", "en"] as const) {
  for (const density of ["comfortable", "compact"] as const) {
    test(`room knowledge at 1280 in ${locale} ${density}`, async ({ page, baseURL }) => {
      const prefix = `${runPrefix()}knowledge-${locale}-${density}`;
      const room = await db.room.create({
        data: {
          name: `${prefix} Long hall name`,
          slug: prefix,
          status: "MAINTENANCE_NEEDED",
          knownIssues: problem,
          tipsNotes: tips,
          lastCheckedAt: new Date("2042-06-15T08:00:00Z"),
        },
      });
      const empty = await db.room.create({
        data: { name: `000 ${prefix} Empty`, slug: `${prefix}-empty`, status: "PROVISIONAL" },
      });
      rooms.push(room.id, empty.id);
      await db.equipment.createMany({
        data: [
          {
            roomId: room.id,
            category: "PC",
            name: "Synthetic PC",
            hostname: "demo-pc",
            ipAddress: "192.0.2.10",
            macAddress: "02:00:00:00:00:10",
            dellServiceTag: "DEMO123",
            dellExpressTag: "123456",
            assetTag: "DEMO-ASSET",
            serial: "DEMO-SERIAL",
          },
          {
            roomId: room.id,
            category: "MICROPHONE",
            name: "Synthetic microphone",
            channelLabel: "Demo channel",
            micKind: "HANDHELD",
            frequencyMhz: 518.125,
            band: "Demo band",
          },
          {
            roomId: room.id,
            category: "PROJECTOR",
            name: "Synthetic projector",
            lampType: "Demo lamp",
            lastLampChangeAt: new Date("2041-02-03T10:00:00Z"),
          },
          { roomId: room.id, category: "REMOTE", name: "Synthetic remote", color: "Demo blue" },
          {
            roomId: room.id,
            category: "MEDIA_CONTROL",
            name: "Synthetic media control",
            color: "Demo silver",
          },
        ],
      });
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/rooms/${room.slug}`);
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
      const problems = page.getByText(problem, { exact: true });
      const notes = page.getByText(tips, { exact: true });
      await expect(problems).toBeVisible();
      expect((await notes.boundingBox())!.y + (await notes.boundingBox())!.height).toBeLessThan(
        800,
      );
      expect(await problems.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe(
        "pre-wrap",
      );
      for (const value of [
        "demo-pc",
        "192.0.2.10",
        "02:00:00:00:00:10",
        "DEMO123",
        "123456",
        "DEMO-ASSET",
        "DEMO-SERIAL",
        "Demo channel",
        "Demo band",
        "MHz",
        "Demo lamp",
        "Demo blue",
        "Demo silver",
      ]) {
        await expect(page.locator("main")).toContainText(value);
      }
      const renders = "test-results/room-knowledge";
      mkdirSync(renders, { recursive: true });
      await page.screenshot({ path: `${renders}/${locale}-${density}-hall.png` });
      await page
        .getByRole("button", { name: t(locale, "rooms.dashboard.checkToday"), exact: true })
        .click();
      await expect
        .poll(async () =>
          (await db.room.findUniqueOrThrow({ where: { id: room.id } })).lastCheckedAt?.getTime(),
        )
        .not.toBe(new Date("2042-06-15T08:00:00Z").getTime());
      await expect(
        page.getByText(t(locale, "history.action.RoomChecked"), { exact: true }),
      ).toBeVisible();
      await page.goto(`/rooms/${empty.slug}`);
      await expect(
        page.getByText(t(locale, "rooms.dashboard.neverChecked"), { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: t(locale, "rooms.dashboard.addReason") }),
      ).toHaveAttribute("href", `/rooms/${empty.slug}/edit#knownIssues`);
      await expect(
        page.getByRole("heading", { name: t(locale, "rooms.knownIssues"), exact: true }),
      ).toHaveCount(0);
      await page.screenshot({ path: `${renders}/${locale}-${density}-empty.png` });
      await page.goto("/rooms");
      await expect(page.locator(`a[href='/rooms/${room.slug}']`)).toBeVisible();
      await page.screenshot({ path: `${renders}/${locale}-${density}-list.png` });
      const issuesHeader = page
        .getByRole("button", { name: t(locale, "rooms.knownIssues"), exact: true })
        .locator("..");
      const issuesCell = page.getByText(problem, { exact: true }).locator("..");
      const nameHeader = page
        .getByRole("button", { name: t(locale, "rooms.col.name"), exact: true })
        .locator("..");
      const headers = nameHeader.locator("..").locator(":scope > div");
      const narrowWidths = await headers.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().width),
      );
      const narrowNameWidth = (await nameHeader.boundingBox())!.width;
      expect(narrowNameWidth).toBeGreaterThanOrEqual(142);
      await page.setViewportSize({ width: 1600, height: 800 });
      await expect
        .poll(async () => (await nameHeader.boundingBox())!.width)
        .toBeCloseTo(narrowNameWidth + 160, 0);
      const wideWidths = await headers.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().width),
      );
      const issuesIndex = await headers.evaluateAll((elements) =>
        elements.findIndex(
          (element) => (element as HTMLElement).dataset.columnId === "knownIssues",
        ),
      );
      expect(wideWidths[issuesIndex]).toBeCloseTo(narrowWidths[issuesIndex] + 160, 0);
      expect(wideWidths.filter((_, index) => index !== 0 && index !== issuesIndex)).toEqual(
        narrowWidths.filter((_, index) => index !== 0 && index !== issuesIndex),
      );
      expect((await issuesCell.boundingBox())!.width).toBeCloseTo(
        (await issuesHeader.boundingBox())!.width,
        1,
      );
      expect((await issuesCell.boundingBox())!.x).toBeCloseTo(
        (await issuesHeader.boundingBox())!.x,
        1,
      );
      if (
        (locale === "de" && density === "comfortable") ||
        (locale === "en" && density === "compact")
      ) {
        await page.screenshot({ path: `${renders}/${locale}-${density}-list-1600.png` });
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      expect(
        await page
          .locator("main")
          .evaluate((element) =>
            [...element.querySelectorAll("*")]
              .filter((child) => getComputedStyle(child).overflowX === "auto")
              .every((child) => child.scrollWidth <= child.clientWidth),
          ),
      ).toBe(true);
      const search = page.getByRole("textbox", { name: t(locale, "common.dataGrid.filterLabel") });
      await search.fill("Synthetic HDMI issue");
      await expect(page.locator(`a[href='/rooms/${room.slug}']`)).toBeVisible();
      await expect(page.locator(`a[href='/rooms/${empty.slug}']`)).toHaveCount(0);
      await expect(page.getByText(problem, { exact: true })).toHaveAttribute("title", problem);
      await search.fill(prefix);
      const sort = page.getByRole("button", { name: t(locale, "rooms.lastChecked"), exact: true });
      for (let direction = 0; direction < 2; direction++) {
        await sort.click();
        await expect
          .poll(
            async () =>
              (await page.locator(`a[href='/rooms/${room.slug}']`).boundingBox())!.y <
              (await page.locator(`a[href='/rooms/${empty.slug}']`).boundingBox())!.y,
          )
          .toBe(true);
      }
      await db.room.update({
        where: { id: room.id },
        data: { lastCheckedAt: new Date("2042-06-15T08:00:00Z") },
      });
      await page.goto(`/rooms/${room.slug}/edit`);
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
      await page.getByRole("button", { name: t(locale, "rooms.edit.submit"), exact: true }).click();
      await expect(page.getByRole("heading", { name: room.name, exact: true })).toBeVisible();
      expect(
        (await db.room.findUniqueOrThrow({ where: { id: room.id } })).lastCheckedAt?.toISOString(),
      ).toBe("2042-06-15T08:00:00.000Z");
      await page.goto(`/rooms/${room.slug}/edit`);
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
      await page
        .getByLabel(t(locale, "rooms.knownIssues"), { exact: true })
        .fill("Synthetic updated problem");
      await page.getByLabel(t(locale, "rooms.lastChecked"), { exact: true }).fill("2042-07-02");
      await page.getByRole("button", { name: t(locale, "rooms.edit.submit"), exact: true }).click();
      await expect(page.getByText("Synthetic updated problem", { exact: true })).toBeVisible();
      await expect
        .poll(async () =>
          (
            await db.room.findUniqueOrThrow({ where: { id: room.id } })
          ).lastCheckedAt?.toISOString(),
        )
        .toBe("2042-07-02T00:00:00.000Z");
    });
  }
}
