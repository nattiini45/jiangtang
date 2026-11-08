import { test, expect } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  for (const chart of ["analytics", "burndown"] as const) {
    test(`chart tooltip text uses the text role [${chart}, ${theme}]`, async ({
      page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: "theme", value: theme, url: baseURL! }]);
      await page.goto(
        chart === "analytics" ? "/analytics" : "/projects/hoersaaltechnik-ws2425?view=burndown",
      );
      await page.waitForSelector("html[data-hydrated]");
      const plot = page.locator(".recharts-wrapper").nth(chart === "analytics" ? 1 : 0);
      await expect(plot).toBeVisible();
      const box = await plot.boundingBox();
      if (!box) throw new Error("Chart has no rendered bounds");
      await plot.hover({ position: { x: box.width / 2, y: box.height / 2 } });
      const item = page.locator(".recharts-tooltip-item").first();
      await expect(item).toBeVisible();
      const colors = await item.evaluate((element) => {
        const sample = document.createElement("span");
        sample.style.color = "var(--popover-foreground)";
        element.append(sample);
        const expected = getComputedStyle(sample).color;
        sample.remove();
        return { actual: getComputedStyle(element).color, expected };
      });
      expect(colors.actual).toBe(colors.expected);
      await page.screenshot({ path: `test-results/colors/${chart}-tooltip-${theme}.png` });
    });
  }
  for (const surface of ["desktop", "mobile"] as const) {
    test(`color roles meet AA contrast [${surface}, ${theme}]`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: "theme", value: theme, url: baseURL! }]);
      if (surface === "mobile") await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(surface === "mobile" ? "/m/tasks" : "/tasks");
      await expect(
        page.getByRole("heading", { level: 1, name: "Aufgaben", exact: true }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

      const pairs = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const sample = document.createElement("span");
        document.body.append(sample);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const color = (name: string) => {
          if (!root.getPropertyValue(`--${name}`).trim()) throw new Error(`Missing token ${name}`);
          sample.style.color = `var(--${name})`;
          return getComputedStyle(sample).color;
        };
        const pixels = (value: string, background?: string) => {
          ctx.clearRect(0, 0, 1, 1);
          if (background) {
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, 1, 1);
          }
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const luminance = (rgb: number[]) =>
          rgb
            .map((v) => v / 255)
            .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const results: { name: string; ratio: number; minimum: number }[] = [];
        const check = (name: string, front: string, back: string, minimum: number) => {
          const a = luminance(pixels(front, back));
          const b = luminance(pixels(back));
          results.push({ name, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), minimum });
        };
        for (const surface of ["background", "card", "popover"]) {
          const background = color(surface);
          if (surface === "card") {
            const track = `rgb(${pixels(color("tint"), background).join(" ")})`;
            check("availability legend mark on card", color("chart-booked"), background, 3);
            check("availability mark on card track", color("chart-booked"), track, 3);
            check("completed Gantt mark on project band", color("chart-complete"), track, 3);
          }
          for (const text of [
            "foreground",
            "muted-foreground",
            "destructive",
            "priority-urgent",
            "priority-high",
            "priority-medium",
            "priority-low",
          ]) {
            check(`${text} on ${surface}`, color(text), background, 4.5);
          }
          for (const indicator of [
            "input",
            "checkbox-ring",
            "focus-ring",
            "switch-track",
            "chart-primary",
            "chart-secondary",
            "chart-complete",
            "chart-critical",
          ]) {
            check(`${indicator} on ${surface}`, color(indicator), background, 3);
          }
          for (const status of ["operational", "fault", "warning", "info", "review"]) {
            const solid = color(`status-${status}`);
            const tintPixels = pixels(`color-mix(in oklab, ${solid} 15%, transparent)`, background);
            const tint = `rgb(${tintPixels.join(" ")})`;
            check(`${status} badge dot on ${surface}`, solid, tint, 3);
            check(`${status} badge label on ${surface}`, color("foreground"), tint, 4.5);
          }
        }
        for (const status of ["operational", "fault", "warning", "info", "review"]) {
          check(
            `${status} solid label`,
            color(`status-${status}-foreground`),
            color(`status-${status}`),
            4.5,
          );
        }
        check("primary label", color("primary-foreground"), color("primary"), 4.5);
        check(
          "primary hover label",
          color("primary-foreground"),
          `color-mix(in oklab, ${color("primary")} 86%, ${color("background")})`,
          4.5,
        );
        check("destructive label", color("destructive-foreground"), color("destructive"), 4.5);
        check(
          "destructive hover label",
          color("destructive-foreground"),
          color("destructive-hover"),
          4.5,
        );
        check("off switch thumb", color("switch-thumb"), color("switch-track"), 3);
        check("on switch thumb", color("switch-thumb"), color("fluid-accent"), 3);
        sample.remove();
        return results;
      });
      await test.info().attach("contrast-pairs", {
        body: JSON.stringify(pairs, null, 2),
        contentType: "application/json",
      });
      expect(pairs.filter(({ ratio, minimum }) => ratio < minimum)).toEqual([]);
    });
  }
}
