import { afterEach, describe, expect, it, vi } from "vitest";
import { isMessageKey, localizeMessage, msgKey } from "~/i18n";
import { resolveLocaleFromHeaders } from "~/i18n/locale.server";
import { currentLocale, runWithLocale, tr } from "~/i18n/request-locale.server";
import { NotFoundError, ValidationError, toErrorResponse } from "~/lib/errors.server";
import { optionalHttpUrl, safeParse, z } from "~/lib/validation.server";

afterEach(() => vi.unstubAllEnvs());

describe("request locale scope", () => {
  it("falls back to the workspace locale outside a scope", () => {
    expect(currentLocale()).toBe("de");
    vi.stubEnv("DEFAULT_LOCALE", "en");
    expect(currentLocale()).toBe("en");
  });

  it("tr() follows the scope, including across awaits", async () => {
    await runWithLocale("en", async () => {
      await Promise.resolve();
      expect(tr("err.notFound")).toBe("Not found.");
    });
    await runWithLocale("de", async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(tr("err.notFound")).toBe("Nicht gefunden.");
    });
  });

  it("keeps concurrent scopes apart", async () => {
    const seen = await Promise.all(
      (["en", "de", "en", "de"] as const).map((locale) =>
        runWithLocale(locale, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return currentLocale();
        }),
      ),
    );
    expect(seen).toEqual(["en", "de", "en", "de"]);
  });

  it("resolves cookie, then Accept-Language, then DEFAULT_LOCALE", () => {
    expect(resolveLocaleFromHeaders("a=1; locale=en", "de-DE")).toBe("en");
    expect(resolveLocaleFromHeaders(undefined, "en-US,en;q=0.9")).toBe("en");
    expect(resolveLocaleFromHeaders(undefined, undefined)).toBe("de");
  });
});

describe("message keys", () => {
  it("translates catalog keys and passes other text through", () => {
    expect(isMessageKey("err.notFound")).toBe(true);
    expect(isMessageKey("toString")).toBe(false);
    expect(localizeMessage("en", msgKey("err.url.invalid"))).toBe("Invalid URL.");
    expect(localizeMessage("de", msgKey("err.url.invalid"))).toBe("Ungültige URL.");
    expect(localizeMessage("en", "free text")).toBe("free text");
  });
});

describe("validation edges", () => {
  const schema = z.object({ site: optionalHttpUrl });

  it("safeParse localizes schema keys to the requested locale", () => {
    const en = safeParse(schema, { site: "javascript:alert(1)" }, "en");
    const de = safeParse(schema, { site: "javascript:alert(1)" }, "de");
    expect(en.success || en.fieldErrors.site).toEqual(["Only http(s) URLs are allowed."]);
    expect(de.success || de.fieldErrors.site).toEqual(["Nur http(s)-URLs erlaubt."]);
  });

  it("safeParse defaults to the request scope", () => {
    const result = runWithLocale("en", () => safeParse(schema, { site: "nope" }));
    expect(result.success || result.fieldErrors.site).toContain("Invalid URL.");
  });

  it("toErrorResponse answers in the request locale", async () => {
    const body = async (e: unknown) => (await toErrorResponse(e).json()) as Record<string, unknown>;
    await runWithLocale("en", async () => {
      expect((await body(new NotFoundError())).message).toBe("Not found.");
      const v = await body(new ValidationError({ site: [msgKey("err.url.invalid")] }));
      expect(v.fieldErrors).toEqual({ site: ["Invalid URL."] });
      expect(v.message).toBe("Invalid input.");
      const z = schema.safeParse({ site: "x" });
      expect(z.success).toBe(false);
      if (!z.success)
        expect(((await body(z.error)).fieldErrors as { site: string[] }).site).toContain(
          "Invalid URL.",
        );
    });
    await runWithLocale("de", async () => {
      expect((await body(new NotFoundError())).message).toBe("Nicht gefunden.");
    });
  });
});
