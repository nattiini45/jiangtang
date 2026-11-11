import { test, expect } from "@playwright/test";

test("MCP connection help copies safe configuration with the keyboard", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/account");
  const section = page.getByRole("region", { name: "Persönliche Zugriffstokens" });
  const details = section.locator("details").filter({ hasText: "Client verbinden" });
  await expect(details).not.toHaveAttribute("open", "");
  const address = section.getByRole("button", { name: "MCP-Adresse kopieren" });
  const addressBox = await address.boundingBox();
  const formBox = await section
    .getByRole("textbox", { name: "Tokenname", exact: true })
    .boundingBox();
  expect(addressBox!.y).toBeLessThan(formBox!.y);
  await address.focus();
  await page.keyboard.press("Enter");
  await expect(section.getByText("Kopiert.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${baseURL}/mcp`);
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  const promptButton = details.getByRole("button", { name: "Prompt für deinen Agenten kopieren" });
  await promptButton.focus();
  await page.keyboard.press("Space");
  await expect(promptButton.locator("../..").locator('[aria-live="polite"]')).toHaveText(
    "Kopiert.",
  );
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toBe(await details.locator("pre").first().textContent());
  expect(prompt).toContain(`${baseURL}/mcp`);
  expect(prompt).toContain("JIANGTANG_MCP_TOKEN");
  expect(prompt).not.toContain("jtg_");
  for (const client of ["Claude Code · .mcp.json", "Cursor · mcp.json"]) {
    const button = details.getByRole("button", { name: `${client} kopieren` });
    await button.focus();
    await page.keyboard.press("Space");
    await expect(button.locator("../..").locator('[aria-live="polite"]')).toHaveText("Kopiert.");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const config = JSON.parse(text).mcpServers.jiangtang;
    expect(config.url).toBe(`${baseURL}/mcp`);
    expect(config.headers.Authorization).toBe(
      client.startsWith("Claude")
        ? "Bearer ${JIANGTANG_MCP_TOKEN}"
        : "Bearer ${env:JIANGTANG_MCP_TOKEN}",
    );
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: () => Promise.reject(new Error("Synthetic clipboard denial")),
    });
  });
  await address.click();
  await expect(section.getByText("Kopieren hat nicht geklappt.", { exact: false })).toBeVisible();
});

test("creating a token never inserts its secret into connection help", async ({ page }) => {
  await page.goto("/account");
  const section = page.getByRole("region", { name: "Persönliche Zugriffstokens" });
  await section
    .getByRole("textbox", { name: "Tokenname", exact: true })
    .fill("Synthetic connection test");
  await section.getByRole("button", { name: "Token erstellen", exact: true }).click();
  const secret = section.getByRole("textbox", { name: "Dein neuer Token" });
  await expect(secret).toHaveValue(/^jtg_/);
  const value = await secret.inputValue();
  await section.getByRole("link", { name: "Client verbinden", exact: true }).click();
  await expect(section.locator("#mcp-connection")).toHaveAttribute("open", "");
  for (const snippet of await section.locator("pre").allTextContents()) {
    expect(snippet).not.toContain(value);
  }
  await section.getByRole("button", { name: "Token ausblenden" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await section.getByRole("button", { name: "Token Synthetic connection test widerrufen" }).click();
  await expect(section.getByRole("status")).toHaveText(
    "Token widerrufen. Er kann nicht mehr auf Jiangtang zugreifen.",
  );
});
