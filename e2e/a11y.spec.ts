import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { runPrefix } from "./run";
import { db } from "~/lib/db.server";
import { createTask } from "~/domains/tasks/tasks.mutations.server";
import { createProject } from "~/domains/projects/projects.mutations.server";
import { createNote } from "~/domains/notes/notes.mutations.server";
import type { AuditActor } from "~/lib/audit.server";

/**
 * Axe sweep — WCAG 2 A/AA tags on the workspace routes, each in light AND
 * dark (the `theme` cookie the app itself sets). Only `serious`/`critical`
 * violations fail the test.
 */

const RUN = runPrefix();

/**
 * Scope the `theme` cookie to the SAME origin the fixture navigates against,
 * derived from Playwright's own `baseURL` fixture rather than a fixed port.
 *
 * Measured impact of the old literal (Chromium, `context.cookies()`): it was
 * stored as `Domain=localhost, Path=/`, and cookies are NOT port-isolated
 * (RFC 6265 8.5), so it was still sent to `http://localhost:3100`. The old code
 * therefore did not break the default configuration. It DID break one this repo
 * explicitly allows: `playwright.config.ts` accepts `127.0.0.1` as the loopback
 * host, and a `Domain=localhost` cookie is not sent to
 * `http://127.0.0.1:3100` — so under `E2E_BASE_URL=http://127.0.0.1:3100` both
 * theme suites would silently measure a single theme and still pass. Deriving
 * the origin from the fixture removes that whole class of drift.
 *
 * Duplicated verbatim in `screens.spec.ts` on purpose: a shared helper module
 * would add another implementation file for no gain.
 */
function themeCookieOrigin(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error(
      "the theme cookie needs the fixture baseURL; playwright.config.ts must set use.baseURL",
    );
  }
  const url = new URL(baseURL);
  if (url.protocol !== "http:") {
    throw new Error(`the theme cookie origin must be loopback HTTP, got ${url.origin}`);
  }
  return url.origin;
}

interface RouteCase {
  name: string;
  path: () => string;
  mobile?: boolean;
}

let taskPath = "";
let ganttPath = "";
let notePath = "";

const ROUTES: RouteCase[] = [
  { name: "dashboard", path: () => "/" },
  { name: "tasks", path: () => "/tasks" },
  { name: "task-detail", path: () => taskPath },
  { name: "board", path: () => "/board" },
  { name: "projects", path: () => "/projects" },
  { name: "project-gantt", path: () => `${ganttPath}?view=gantt` },
  { name: "notes", path: () => "/notes" },
  { name: "note-editor", path: () => notePath },
  { name: "activity", path: () => "/activity" },
  { name: "search", path: () => "/search?q=Lager" },
  { name: "timesheet", path: () => "/timesheet" },
  { name: "capacity", path: () => "/capacity" },
  { name: "import", path: () => "/import" },
  { name: "m-tasks", path: () => "/m/tasks", mobile: true },
  { name: "m-tasks-new", path: () => "/m/tasks/new", mobile: true },
];

test.beforeAll(async () => {
  const email = process.env.ADMIN_EMAIL;
  const user = await db.user.findFirstOrThrow({ where: { email } });
  const actor: AuditActor = { id: user.id, name: user.name, initials: user.initials };
  const project = await createProject(actor, {
    name: `${RUN}A11y Projekt`,
    description: undefined,
    status: "CONFIRMED",
    color: undefined,
    startAt: undefined,
    dueAt: undefined,
    leadId: undefined,
    parentProjectId: undefined,
  });
  ganttPath = `/projects/${project.slug}`;
  const task = await createTask(actor, {
    title: `${RUN}A11y Aufgabe`,
    body: "",
    status: "IN_PROGRESS",
    priority: undefined,
    startAt: undefined,
    dueAt: undefined,
    estimateMinutes: undefined,
    projectId: project.id,
    parentTaskId: undefined,
    locationId: undefined,
    labels: [],
  });
  taskPath = `/tasks/${task.id}`;
  const note = await createNote(actor, {
    title: `${RUN}A11y Notiz`,
    body: "",
    tags: [],
    pinned: false,
    projectId: undefined,
    locationId: undefined,
  });
  notePath = `/notes/${note.id}`;
});

for (const theme of ["light", "dark"] as const) {
  for (const route of ROUTES) {
    test(`${route.name} [${theme}] — no serious/critical axe violations`, async ({
      page,
      baseURL,
    }) => {
      await page
        .context()
        .addCookies([{ name: "theme", value: theme, url: themeCookieOrigin(baseURL) }]);
      if (route.mobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(route.path());
      await page.waitForLoadState("load");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const serious = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(
        serious.map(
          (v) =>
            `${v.id} (${v.impact}): ${v.nodes
              .map((n) => n.target.join(" "))
              .slice(0, 4)
              .join(", ")}`,
        ),
      ).toEqual([]);
    });
  }
}

/**
 * The language switcher in both shells (desktop header, mobile "More" menu),
 * axe-scanned in both languages and operated with the keyboard alone.
 */
async function axeSerious(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const switcher = (page: Page) => page.getByRole("group", { name: /^(Language|Sprache)$/ });

test.describe("language switcher", () => {
  for (const locale of ["de", "en"] as const) {
    test(`desktop header [${locale}] — no serious/critical axe violations`, async ({
      page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: "locale", value: locale, url: baseURL! }]);
      await page.goto("/");
      await expect(switcher(page)).toBeVisible();
      expect(await axeSerious(page)).toEqual([]);
    });

    test(`mobile More menu [${locale}] — no serious/critical axe violations`, async ({
      page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: "locale", value: locale, url: baseURL! }]);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/m");
      await page.waitForSelector("html[data-hydrated]");
      await page.getByRole("button", { name: locale === "de" ? "Mehr" : "More" }).click();
      await expect(switcher(page)).toBeVisible();
      expect(await axeSerious(page)).toEqual([]);
    });
  }

  test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] }, locale: "en-US" });

    test("login [en] — no serious/critical axe violations", async ({ page }) => {
      await page.goto("/login");
      await expect(switcher(page)).toBeVisible();
      expect(await axeSerious(page)).toEqual([]);
    });

    test("the switcher is reachable and operable with the keyboard only", async ({ page }) => {
      await page.goto("/login");
      await page.waitForSelector("html[data-hydrated]", { timeout: 5_000 }).catch(() => undefined);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");

      // Tab from the top of the page until focus lands on the "Deutsch" option.
      let focused = "";
      for (let i = 0; i < 20 && focused !== "Deutsch"; i++) {
        await page.keyboard.press("Tab");
        focused = await page.evaluate(
          () => document.activeElement?.getAttribute("aria-label") ?? "",
        );
      }
      expect(focused).toBe("Deutsch");
      await expect(page.getByRole("button", { name: "Deutsch" })).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(page.locator("html")).toHaveAttribute("lang", "de");
      await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();

      // Back to English with Space, starting from a fresh Tab walk.
      await page.getByRole("button", { name: "English" }).focus();
      await page.keyboard.press("Space");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.getByRole("button", { name: "English" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });
});
