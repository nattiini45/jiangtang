import { devices, expect, test } from "@playwright/test";

const PHONE_UA = devices["iPhone 13"].userAgent;
const TABLET_UA = devices["iPad (gen 7)"].userAgent;

test("equipment QR entry retains the equipment as a capture default", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  await page.goto("/inventory/seed_equipment_projector_a01");
  await expect(page).toHaveURL(/\/m\?equipmentId=seed_equipment_projector_a01$/);
  await expect(page.locator('select[name="equipmentId"]')).toHaveValue(
    "seed_equipment_projector_a01",
  );
});

test("an expired desktop switch can sign in without landing on an action-only URL", async ({
  browser,
  baseURL,
}) => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set");
  const context = await browser.newContext({ baseURL, storageState: "e2e/.auth/admin.json" });
  try {
    await context.addCookies([{ name: "view", value: "desktop", url: baseURL! }]);
    const page = await context.newPage();
    await page.goto("/rooms/demo-a01");
    await page.waitForSelector("html[data-hydrated]");
    const view = (await context.cookies()).find((cookie) => cookie.name === "view")!;
    await context.clearCookies();
    await context.addCookies([view]);
    await page.getByRole("button", { name: "Zur Mobilansicht wechseln", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fprefs%2Fview$/);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form:has(input[name="email"]) button[type="submit"]').click();
    await expect(page).toHaveURL(new URL("/", baseURL!).href);
    await expect(
      page.getByRole("button", { name: "Zur Mobilansicht wechseln", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("note rows keep reading in the mobile view", async ({ page }) => {
  await page.goto("/m/notes");
  await page
    .locator('a[href^="/m/notes/"]')
    .filter({ has: page.locator("span") })
    .first()
    .click();
  await expect(page).toHaveURL(/\/m\/notes\/[^/]+$/);
  await expect(page.getByTestId("markdown-preview")).toBeVisible();
});

test("phone document entry maps a room deep link to the mobile equivalent", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    baseURL,
    storageState: "e2e/.auth/admin.json",
    extraHTTPHeaders: { "sec-ch-ua-mobile": "?1" },
  });
  try {
    const page = await context.newPage();
    await page.goto("/rooms/demo-a01");
    await expect(page).toHaveURL(/\/m\/rooms\/demo-a01$/);
    await expect(page.getByRole("heading", { level: 1, name: "Demo-Raum A.01" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("desktop client navigation uses single-fetch redirects under a mobile override", async ({
  page,
  baseURL,
}) => {
  await page.goto("/tasks");
  await page.waitForSelector("html[data-hydrated]");
  await page.context().addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  const singleFetch = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/rooms.data",
  );
  await page.getByRole("link", { name: "Räume", exact: true }).click();
  const response = await singleFetch;
  expect(response.status()).toBe(202);
  expect(response.headers()["content-type"]).toContain("text/x-script");
  await expect(page).toHaveURL(/\/m\/rooms$/);
  await expect(page.getByRole("heading", { level: 1, name: "Räume", exact: true })).toBeVisible();
});

test("explicit switches persist and round-trip the current detail", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  await page.goto("/rooms/demo-a01");
  await page.waitForSelector("html[data-hydrated]");
  await page.getByRole("button", { name: "Mehr", exact: true }).click();
  await page.getByRole("button", { name: "Desktop-Version", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/demo-a01$/);
  expect((await page.context().cookies()).find((cookie) => cookie.name === "view")?.value).toBe(
    "desktop",
  );
  await page.reload();
  await expect(page).toHaveURL(/\/rooms\/demo-a01$/);
  await page.getByRole("button", { name: "Zur Mobilansicht wechseln", exact: true }).click();
  await expect(page).toHaveURL(/\/m\/rooms\/demo-a01$/);
  expect((await page.context().cookies()).find((cookie) => cookie.name === "view")?.value).toBe(
    "mobile",
  );
  await page.goto("/");
  await expect(page).toHaveURL(/\/m$/);
});

test("a room's desktop escape persists the override instead of redirecting in a loop", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  await page.goto("/m/rooms/demo-a01?date=2026-10-25");
  await page
    .getByRole("button", { name: "Vollständige Raum-Ansicht (Desktop)", exact: true })
    .click();
  await expect(page).toHaveURL(/\/rooms\/demo-a01\?date=2026-10-25$/);
  expect((await page.context().cookies()).find((cookie) => cookie.name === "view")?.value).toBe(
    "desktop",
  );
});

test("a signed-out phone signs in and returns to its mobile detail", async ({
  browser,
  baseURL,
}) => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set");
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    baseURL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "sec-ch-ua-mobile": "?1" },
  });
  try {
    const page = await context.newPage();
    await page.goto("/tasks/seed_task_hs_01");
    await expect(page).toHaveURL(/\/login\?next=%2Fm%2Ftasks%2Fseed_task_hs_01$/);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form:has(input[name="email"]) button[type="submit"]').click();
    await expect(page).toHaveURL(/\/m\/tasks\/seed_task_hs_01$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Beamer-Vergleich 2025 durchführen" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("client hints win, UA fallback recognizes phones, and tablets stay desktop", async ({
  request,
}) => {
  for (const [headers, expected] of [
    [{ "user-agent": PHONE_UA }, "/m/rooms"],
    [{ "user-agent": PHONE_UA, "sec-ch-ua-mobile": "?0" }, null],
    [{ "user-agent": "Desktop browser", "sec-ch-ua-mobile": "?1" }, "/m/rooms"],
    [{ "user-agent": TABLET_UA }, null],
    [{ "user-agent": "Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit Chrome Safari" }, null],
  ] as const) {
    const response = await request.get("/rooms", { headers, maxRedirects: 0 });
    expect(response.status()).toBe(expected ? 302 : 200);
    expect(response.headers().location ?? null).toBe(expected);
  }
  const resource = await request.get("/api/search?q=room", {
    headers: { "sec-ch-ua-mobile": "?1" },
    maxRedirects: 0,
  });
  expect(resource.headers().location).toBeUndefined();
  expect(resource.headers()["content-type"]).toContain("application/json");
});
