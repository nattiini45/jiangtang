import { test, expect, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("the real worker controls the exact manifest launch URL without announcing a first-install update", async ({
  page,
  baseURL,
}) => {
  await page.goto("/m");
  await page.waitForSelector("html[data-hydrated]");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(new URL("/m", baseURL).href);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
    .toBe(new URL("/sw.js", baseURL).href);
  await page.reload();
  await page.waitForSelector("html[data-hydrated]");
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(
    new URL("/sw.js", baseURL).href,
  );
  await expect(page.getByRole("complementary", { name: "Update verfügbar" })).toHaveCount(0);
});

async function mockPwa(
  page: Page,
  options: { ios?: boolean; standalone?: boolean; blockedStorage?: boolean } = {},
) {
  await page.addInitScript((options) => {
    const registration = Object.assign(new EventTarget(), {
      scope: `${location.origin}/m`,
      active: {},
      installing: null,
      waiting: null as object | null,
      update: async () => {},
    });
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        register: async () => registration,
        getRegistrations: async () => [registration],
      },
    });
    Object.assign(window, {
      showPwaUpdate: () => {
        registration.waiting = {
          postMessage: () => {
            throw new Error("unsafe activation");
          },
        };
        registration.dispatchEvent(new Event("updatefound"));
      },
      fireInstall: (outcome = "dismissed", fails = false) => {
        const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
          prompt: async () => {
            document.documentElement.dataset.prompted = "true";
            if (fails) throw new Error("not available");
          },
          userChoice: Promise.resolve({ outcome }),
        });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      },
    });
    if (options.ios) Object.defineProperty(navigator, "userAgent", { value: "iPhone Safari" });
    if (options.standalone) Object.defineProperty(navigator, "standalone", { value: true });
    if (options.blockedStorage) {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("blocked");
        },
      });
    }
  }, options);
}

async function mobile(page: Page) {
  await page.goto("/m/tasks/new");
  await page.waitForSelector("html[data-hydrated]");
}

function fireInstall(page: Page, outcome: "accepted" | "dismissed" = "dismissed", fails = false) {
  return page.evaluate(
    ([outcome, fails]) =>
      (
        window as unknown as { fireInstall: (outcome: string, fails: boolean) => boolean }
      ).fireInstall(outcome, fails),
    [outcome, fails] as const,
  );
}

test("Android install stays user-initiated, dismisses persistently and never steals a draft", async ({
  page,
}) => {
  await mockPwa(page);
  await mobile(page);
  await page.locator("#title").fill("Synthetic unsaved capture");
  expect(await fireInstall(page)).toBe(true);
  await expect(page.getByRole("complementary", { name: "Jiangtang als App nutzen" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-prompted", "true");
  await expect(page.locator("#title")).toHaveValue("Synthetic unsaved capture");
  await page.getByRole("button", { name: "Hinweis schließen" }).click();
  expect(await page.evaluate(() => localStorage.getItem("jiangtang-pwa-install-v1"))).toBe(
    "dismissed",
  );
  await page.reload();
  await page.waitForSelector("html[data-hydrated]");
  await fireInstall(page);
  await expect(page.getByRole("button", { name: "App installieren" })).toHaveCount(0);
});

for (const outcome of ["accepted", "dismissed"] as const) {
  test(`Android browser prompt ${outcome} is remembered`, async ({ page }) => {
    await mockPwa(page);
    await mobile(page);
    await fireInstall(page, outcome);
    await page.getByRole("button", { name: "App installieren" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-prompted", "true");
    await expect(page.getByRole("button", { name: "App installieren" })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("jiangtang-pwa-install-v1"))).toBe(
      outcome === "accepted" ? "installed" : "dismissed",
    );
  });
}

test("an installed event removes the hint, and a failed prompt remains non-fatal", async ({
  page,
}) => {
  await mockPwa(page);
  await mobile(page);
  await fireInstall(page);
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.getByRole("button", { name: "App installieren" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("jiangtang-pwa-install-v1"))).toBe(
    "installed",
  );
  await page.evaluate(() => localStorage.removeItem("jiangtang-pwa-install-v1"));
  await page.reload();
  await page.waitForSelector("html[data-hydrated]");
  await fireInstall(page, "dismissed", true);
  await page.getByRole("button", { name: "App installieren" }).click();
  await expect(page.getByRole("button", { name: "App installieren" })).toHaveCount(0);
  await expect(page.locator("#title")).toBeEditable();
});

test("iOS gets localized home-screen instructions once, with no native prompt", async ({
  page,
}) => {
  await mockPwa(page, { ios: true });
  await mobile(page);
  await expect(page.getByText(/Tippe im Browser auf „Teilen“/)).toBeVisible();
  await expect(page.getByRole("button", { name: "App installieren" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/pwa-install-ios-de.png" });
  await page.reload();
  await page.waitForSelector("html[data-hydrated]");
  await expect(page.getByText(/Tippe im Browser auf „Teilen“/)).toHaveCount(0);
});

test("English iOS instructions and dark chrome use the app's floor", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    { name: "locale", value: "en", url: baseURL! },
    { name: "theme", value: "dark", url: baseURL! },
  ]);
  await mockPwa(page, { ios: true });
  await mobile(page);
  await expect(page.getByText(/Tap Share in your browser/)).toBeVisible();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#171717");
  await page.screenshot({ path: "test-results/pwa-install-ios-en-dark.png" });
});

test("standalone launch never shows install guidance", async ({ page }) => {
  await mockPwa(page, { ios: true, standalone: true });
  await mobile(page);
  await fireInstall(page);
  await expect(page.getByRole("complementary", { name: "Jiangtang als App nutzen" })).toHaveCount(
    0,
  );
});

test("two open tabs do not repeat the device's install hint", async ({ page, context }) => {
  const other = await context.newPage();
  await mockPwa(page);
  await mockPwa(other);
  await mobile(page);
  await mobile(other);
  await fireInstall(page);
  await expect(page.getByRole("button", { name: "App installieren" })).toBeVisible();
  await fireInstall(other);
  await expect(other.getByRole("button", { name: "App installieren" })).toHaveCount(0);
  await page.getByRole("button", { name: "Hinweis schließen" }).click();
  await fireInstall(other);
  await expect(other.getByRole("button", { name: "App installieren" })).toHaveCount(0);
});

test("unavailable device storage does not break dismissal or navigation", async ({ page }) => {
  await mockPwa(page, { blockedStorage: true });
  await mobile(page);
  await fireInstall(page);
  await page.getByRole("button", { name: "Hinweis schließen" }).click();
  await fireInstall(page);
  await expect(page.getByRole("button", { name: "App installieren" })).toHaveCount(0);
  await page.getByRole("link", { name: "Aufgaben", exact: true }).click();
  await expect(page).toHaveURL(/\/m\/tasks$/);
});

test("a waiting update keeps an in-flight capture and its tab intact", async ({ page }) => {
  await mockPwa(page);
  await mobile(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/m/tasks/new.data", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await gate;
    await route.abort("internetdisconnected");
  });
  await page.locator("#title").fill("Synthetic update capture");
  const posting = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().includes("/m/tasks/new.data"),
  );
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await posting;
  await page.evaluate(() => {
    (window as unknown as { showPwaUpdate: () => void }).showPwaUpdate();
  });
  await expect(page.getByRole("status").filter({ hasText: "Update verfügbar" })).toBeVisible();
  await expect(page.locator("#title")).toHaveValue("Synthetic update capture");
  await page.screenshot({ path: "test-results/pwa-waiting-update.png" });
  release();
  await expect(
    page.getByText("Offline gespeichert — wird gesendet, sobald du online bist.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Später", exact: true }).click();
  await expect(
    page.getByText("Offline gespeichert — wird gesendet, sobald du online bist.", { exact: true }),
  ).toBeVisible();
  const queued = await page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("jiangtang-offline", 1);
        open.onsuccess = () => {
          const request = open.result.transaction("captures").objectStore("captures").getAll();
          request.onsuccess = () => {
            resolve(request.result);
            open.result.close();
          };
          request.onerror = () => reject(request.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
  expect(queued).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        fields: expect.objectContaining({ title: "Synthetic update capture" }),
      }),
    ]),
  );
});
