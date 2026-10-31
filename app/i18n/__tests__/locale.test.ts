import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLocaleCookie,
  parseAcceptLanguage,
  resolveLocale,
  setLocaleCookie,
  workspaceLocale,
} from "~/i18n/locale.server";
import { isLocale, localeTag, matchLocale } from "~/i18n/locales";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/", { headers });
}

afterEach(() => vi.unstubAllEnvs());

describe("matchLocale", () => {
  it("maps by primary subtag, case-insensitively", () => {
    expect(matchLocale("de")).toBe("de");
    expect(matchLocale("DE-at")).toBe("de");
    expect(matchLocale("en_US")).toBe("en");
    expect(matchLocale(" en-GB ")).toBe("en");
  });

  it("rejects unsupported and empty values", () => {
    expect(matchLocale("fr")).toBeNull();
    expect(matchLocale("")).toBeNull();
    expect(matchLocale(undefined)).toBeNull();
    expect(matchLocale("*")).toBeNull();
  });

  it("exposes Intl tags and a strict type guard", () => {
    expect(localeTag("de")).toBe("de-DE");
    expect(localeTag("en")).toBe("en-GB");
    expect(isLocale("de")).toBe(true);
    expect(isLocale("de-DE")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});

describe("workspaceLocale", () => {
  it("reads DEFAULT_LOCALE", () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    expect(workspaceLocale()).toBe("de");
    vi.stubEnv("DEFAULT_LOCALE", "EN");
    expect(workspaceLocale()).toBe("en");
  });

  it("falls back to English when unset, blank or unsupported", () => {
    vi.stubEnv("DEFAULT_LOCALE", "");
    expect(workspaceLocale()).toBe("en");
    vi.stubEnv("DEFAULT_LOCALE", "klingon");
    expect(workspaceLocale()).toBe("en");
  });
});

describe("parseAcceptLanguage", () => {
  it("picks the highest q-value among supported languages", () => {
    expect(parseAcceptLanguage("de;q=0.5, en;q=0.9")).toBe("en");
    expect(parseAcceptLanguage("fr-CH, fr;q=0.9, de;q=0.8, en;q=0.7")).toBe("de");
  });

  it("treats a missing q as 1 and keeps header order on ties", () => {
    expect(parseAcceptLanguage("de-DE,en-US")).toBe("de");
    expect(parseAcceptLanguage("en-US,de-DE")).toBe("en");
    expect(parseAcceptLanguage("en;q=0.8, de")).toBe("de");
  });

  it("skips q=0, wildcards, unsupported languages and malformed q", () => {
    expect(parseAcceptLanguage("de;q=0, en;q=0.1")).toBe("en");
    expect(parseAcceptLanguage("*")).toBeNull();
    expect(parseAcceptLanguage("fr, es;q=0.4")).toBeNull();
    expect(parseAcceptLanguage("de;q=abc")).toBeNull();
    expect(parseAcceptLanguage("")).toBeNull();
    expect(parseAcceptLanguage(null)).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("prefers a valid locale cookie over Accept-Language and the env default", () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    expect(resolveLocale(req({ cookie: "locale=en", "accept-language": "de-DE" }))).toBe("en");
    vi.stubEnv("DEFAULT_LOCALE", "en");
    expect(resolveLocale(req({ cookie: "a=1; locale=de; b=2", "accept-language": "en" }))).toBe(
      "de",
    );
  });

  it("ignores an invalid cookie and falls through to Accept-Language", () => {
    vi.stubEnv("DEFAULT_LOCALE", "en");
    expect(resolveLocale(req({ cookie: "locale=fr", "accept-language": "de" }))).toBe("de");
    expect(resolveLocale(req({ cookie: "locale=", "accept-language": "de" }))).toBe("de");
    expect(resolveLocale(req({ cookie: "locale=de-DE", "accept-language": "en" }))).toBe("en");
    expect(resolveLocale(req({ cookie: "xlocale=de", "accept-language": "en" }))).toBe("en");
  });

  it("uses Accept-Language q-values when there is no cookie", () => {
    vi.stubEnv("DEFAULT_LOCALE", "en");
    expect(resolveLocale(req({ "accept-language": "en;q=0.4, de;q=0.9" }))).toBe("de");
  });

  it("falls back to DEFAULT_LOCALE when the header names no supported language", () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    expect(resolveLocale(req({ "accept-language": "fr, ja;q=0.5" }))).toBe("de");
    expect(resolveLocale(req())).toBe("de");
  });

  it("falls back to English when nothing else decides", () => {
    vi.stubEnv("DEFAULT_LOCALE", "");
    expect(resolveLocale(req())).toBe("en");
    vi.stubEnv("DEFAULT_LOCALE", "xx");
    expect(resolveLocale(req({ "accept-language": "fr" }))).toBe("en");
  });
});

describe("locale cookie", () => {
  it("round-trips through the writer and the reader", () => {
    const setCookie = setLocaleCookie("en");
    expect(setCookie).toMatch(/^locale=en; Path=\/; Max-Age=31536000; SameSite=Lax/);
    expect(getLocaleCookie(req({ cookie: setCookie.split(";")[0]! }))).toBe("en");
  });
});
