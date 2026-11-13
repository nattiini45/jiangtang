import { test, expect, type Page } from "@playwright/test";

/**
 * Language selection at the browser boundary. The suite default (de-DE, admin
 * session) is overridden per describe block: `locale` drives the browser's
 * Accept-Language header and the empty storage state means no `locale` cookie,
 * so what is rendered comes from the header, the switcher or `DEFAULT_LOCALE`.
 */

const ANONYMOUS = { cookies: [], origins: [] };

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(process.env.ADMIN_EMAIL!);
  await page.locator('input[name="password"]').fill(process.env.ADMIN_PASSWORD!);
  await page.locator('form:has(input[name="email"]) button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
}

function switcher(page: Page) {
  return page.getByRole("group", { name: /^(Language|Sprache)$/ });
}

test.describe("English browser, no cookie", () => {
  test.use({ locale: "en-US", storageState: ANONYMOUS });

  test("login renders English and <html lang=en>", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByText("Sign in to your AV workspace.")).toBeVisible();
    await expect(page.getByText("Email", { exact: true })).toBeVisible();
    await expect(page.getByText("Password", { exact: true })).toBeVisible();
  });

  test("invalid credentials show the English error", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill("nobody@example.test");
    await page.locator('input[name="password"]').fill("definitely-wrong");
    await page.locator('form:has(input[name="email"]) button[type="submit"]').click();
    await expect(page.getByText("Invalid email or password.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("an unknown invite link says so in English", async ({ page }) => {
    await page.goto("/accept-invite/no-such-token");
    await expect(
      page.getByRole("heading", { name: "This invitation is no longer valid", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Ask the administrator who invited you for a new invitation link.", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("the switcher changes the language, keeps the route and survives a reload", async ({
    page,
    context,
  }) => {
    await page.goto("/login?next=%2Ftasks");
    const group = switcher(page);
    await expect(group.getByRole("button", { name: "English" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await group.getByRole("button", { name: "Deutsch" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/login\?next=%2Ftasks/);
    expect((await context.cookies()).find((c) => c.name === "locale")?.value).toBe("de");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
  });

  test("the switcher is keyboard operable", async ({ page }) => {
    await page.goto("/login");
    await switcher(page).getByRole("button", { name: "Deutsch" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
  });

  test("shell, command palette and mobile menu follow the chosen language", async ({
    page,
    context,
  }) => {
    await signIn(page);
    await page.waitForSelector("html[data-hydrated]");
    const nav = page.getByRole("complementary").getByRole("navigation");
    await expect(nav.getByRole("link", { name: "Tasks", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Rooms", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await expect(palette.getByText("Create task")).toBeVisible();
    await expect(palette.getByText("Go to Rooms")).toBeVisible();
    await page.keyboard.press("Escape");

    await switcher(page).getByRole("button", { name: "Deutsch" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(nav.getByRole("link", { name: "Aufgaben", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abmelden" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Befehlspalette" })).toBeVisible();
    await page.keyboard.press("Escape");

    // The same cookie drives the mobile PWA; switch back from its "More" menu.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/m");
    await page.waitForSelector("html[data-hydrated]");
    await page.getByRole("button", { name: "Mehr" }).click();
    await switcher(page).getByRole("button", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === "locale")?.value).toBe("en");
  });
});

test.describe("login hydration", () => {
  for (const locale of ["en-US", "de-DE"]) {
    test.describe(locale, () => {
      test.use({ locale, storageState: ANONYMOUS });

      test("renders without hydration diagnostics", async ({ page }) => {
        const diagnostics: string[] = [];
        page.on("console", (msg) => {
          if (/hydrat|did not match/i.test(msg.text())) diagnostics.push(msg.text());
        });
        page.on("pageerror", (e) => diagnostics.push(e.message));
        await page.goto("/login");
        await page.waitForLoadState("load");
        await page.waitForTimeout(1000);
        expect(diagnostics).toEqual([]);
      });
    });
  }
});

test.describe("German browser, no cookie", () => {
  test.use({ locale: "de-DE", storageState: ANONYMOUS });

  test("Accept-Language de shows the German login", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
    await expect(page.getByText("Anmeldung für dein AV-Workspace.")).toBeVisible();
  });

  test("a cookie beats Accept-Language", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });
});

test.describe("unsupported browser language", () => {
  test.use({ locale: "fr-FR", storageState: ANONYMOUS });

  // The webServer pins DEFAULT_LOCALE=de, so an unsupported language lands on it.
  test("falls back to DEFAULT_LOCALE", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
  });
});

test.describe("unmatched URLs", () => {
  test.use({ locale: "fr-FR", storageState: ANONYMOUS });

  const CASES = [
    {
      locale: "en",
      detail: "The page you are looking for does not exist or has moved.",
      title: "Page not found · Jiangtang",
    },
    {
      locale: "de",
      detail: "Die gesuchte Seite existiert nicht oder wurde verschoben.",
      title: "Seite nicht gefunden · Jiangtang",
    },
  ] as const;

  for (const { locale, detail, title } of CASES) {
    for (const path of ["/does-not-exist", "/m/does-not-exist"]) {
      test(`${path} is a ${locale} 404 for a signed-out visitor with the locale cookie`, async ({
        page,
        context,
        baseURL,
      }) => {
        await context.addCookies([{ name: "locale", value: locale, url: baseURL! }]);
        const response = await page.goto(path);
        expect(response?.status()).toBe(404);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("h1")).toHaveText("404");
        await expect(page.getByText(detail)).toBeVisible();
        await expect(page).toHaveTitle(title);
      });
    }
  }

  test("without a cookie the language follows DEFAULT_LOCALE", async ({ page }) => {
    const response = await page.goto("/does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
  });

  test("the health probe is not shadowed by the catch-all", async ({ request }) => {
    const response = await request.get("/healthz");
    expect(response.status()).toBe(200);
  });
});
