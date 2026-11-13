import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG,
  CONFIG_REGISTRY,
  readConfig,
  readRawConfig,
  type ConfigName,
} from "~/lib/config.server";
import { readAiConfig } from "~/lib/ai/config.server";
import { ENVIRONMENT_VARIABLES, environmentStatus } from "~/lib/environment.server";

afterEach(() => vi.unstubAllEnvs());

const defaults: Partial<Record<ConfigName, unknown>> = {
  PORT: 3000,
  APP_COMMIT: "unknown",
  DEFAULT_LOCALE: "en",
  LANDING_PAGE_ENABLED: false,
  REQUIRE_ADMIN_TWO_FACTOR: false,
  DEV_ADMIN_EMAIL: "admin@jiangtang.local",
  DEV_ADMIN_PASSWORD: "jiangtang-admin",
  STORAGE_DIR: "./data/attachments",
  STORAGE_KEY_SALT: "jiangtang-storage-v1",
  EMBEDDING_DIMENSIONS: 1024,
  EMBEDDING_SEND_DIMENSIONS: true,
  EMBEDDING_QUERY_TEMPLATE: "Instruct: {instruction}\nQuery:{text}",
  EMBEDDING_QUERY_INSTRUCTION:
    "Given a search query in an AV and facility management workspace, retrieve the records that answer the query",
  EMBEDDING_PASSAGE_TEMPLATE: "{text}",
  GENERATION_MAX_TOKENS: 800,
  GENERATION_SYSTEM_ROLE: "system",
  LOG_LEVEL: "info",
  ACTIVITY_RETENTION_DAYS: 2555,
  FUNCTION_CONFIRMATION_DAYS: 200,
  WARRANTY_WINDOW_DAYS: 30,
};
const emptyRetained = new Set<ConfigName>([
  "NODE_ENV",
  "DATABASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "ADMIN_INITIALS",
  "DEV_ADMIN_EMAIL",
  "DEV_ADMIN_PASSWORD",
  "STORAGE_DIR",
  "STORAGE_ENCRYPTION_KEY",
  "ICAL_FEED_TOKEN",
  "CALDAV_URL",
  "CALDAV_USERNAME",
  "CALDAV_PASSWORD",
  "SEARCH_INDEXER",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL",
  "RERANK_BASE_URL",
  "RERANK_MODEL",
  "GENERATION_BASE_URL",
  "GENERATION_MODEL",
  "LOG_LEVEL",
  "GLITCHTIP_DSN",
]);

describe("configuration registry", () => {
  it("keeps boot and destructive settings environment-only and credential values secret", () => {
    for (const name of [
      "NODE_ENV",
      "APP_COMMIT",
      "PORT",
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "STORAGE_DIR",
      "STORAGE_ENCRYPTION_KEY",
      "STORAGE_KEY_SALT",
      "ADMIN_EMAIL",
      "ADMIN_PASSWORD",
      "ADMIN_INITIALS",
      "DEV_ADMIN_EMAIL",
      "DEV_ADMIN_PASSWORD",
      "GLITCHTIP_DSN",
      "LOG_LEVEL",
      "EMBEDDING_DIMENSIONS",
      "ACTIVITY_RETENTION_DAYS",
    ] as const)
      expect(CONFIG[name].environmentOnly).toBe(true);
    for (const name of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "STORAGE_ENCRYPTION_KEY",
      "ADMIN_PASSWORD",
      "DEV_ADMIN_PASSWORD",
      "ICAL_FEED_TOKEN",
      "CALDAV_PASSWORD",
      "EMBEDDING_API_KEY",
      "RERANK_API_KEY",
      "GENERATION_API_KEY",
      "GLITCHTIP_DSN",
    ] as const)
      expect(CONFIG[name].secret).toBe(true);
  });

  it.each(CONFIG_REGISTRY)("preserves unset and empty semantics for $name", ({ name }) => {
    vi.stubEnv(name, undefined);
    expect(readRawConfig(name)).toBeUndefined();
    expect(readConfig(name)).toEqual(defaults[name]);
    expect(CONFIG[name].default).toEqual(defaults[name]);
    vi.stubEnv(name, "");
    expect(readRawConfig(name)).toBe("");
    expect(readConfig(name)).toEqual(
      name === "PORT" ? 0 : emptyRetained.has(name) ? "" : defaults[name],
    );
  });

  it("reads the current environment each time and never changes an injected environment", () => {
    vi.stubEnv("DEV_ADMIN_EMAIL", "first@example.test");
    expect(readConfig("DEV_ADMIN_EMAIL")).toBe("first@example.test");
    vi.stubEnv("DEV_ADMIN_EMAIL", "second@example.test");
    expect(readConfig("DEV_ADMIN_EMAIL")).toBe("second@example.test");
    expect(readConfig("DEV_ADMIN_EMAIL", Object.freeze({}))).toBe("admin@jiangtang.local");
    expect(readConfig("DEV_ADMIN_EMAIL")).toBe("second@example.test");
  });

  it.each(["ACTIVITY_RETENTION_DAYS", "WARRANTY_WINDOW_DAYS"] as const)(
    "keeps fractional positive %s and rejects malformed numbers",
    (name) => {
      expect(readConfig(name, { [name]: "1.5" })).toBe(1.5);
      for (const raw of [" ", "0", "-2", "invalid", "Infinity"])
        expect(readConfig(name, { [name]: raw })).toBe(defaults[name]);
    },
  );

  it("keeps the different boolean dialects", () => {
    for (const raw of ["false", " OFF ", "0", "NO"])
      expect(readConfig("EMBEDDING_SEND_DIMENSIONS", { EMBEDDING_SEND_DIMENSIONS: raw })).toBe(
        false,
      );
    expect(readConfig("EMBEDDING_SEND_DIMENSIONS", { EMBEDDING_SEND_DIMENSIONS: "anything" })).toBe(
      true,
    );
    expect(readConfig("REQUIRE_ADMIN_TWO_FACTOR", { REQUIRE_ADMIN_TWO_FACTOR: "TRUE" })).toBe(
      false,
    );
    expect(readConfig("REQUIRE_ADMIN_TWO_FACTOR", { REQUIRE_ADMIN_TWO_FACTOR: "true" })).toBe(true);
    expect(readConfig("LANDING_PAGE_ENABLED", { LANDING_PAGE_ENABLED: "true" })).toBe(false);
    expect(readConfig("LANDING_PAGE_ENABLED", { LANDING_PAGE_ENABLED: "1" })).toBe(true);
  });

  it("keeps whitespace in storage salts and passwords but trims account names", () => {
    expect(readConfig("STORAGE_KEY_SALT", { STORAGE_KEY_SALT: " salt " })).toBe(" salt ");
    expect(readConfig("STORAGE_KEY_SALT", { STORAGE_KEY_SALT: " " })).toBe(
      defaults.STORAGE_KEY_SALT,
    );
    expect(readConfig("CALDAV_PASSWORD", { CALDAV_PASSWORD: " secret " })).toBe(" secret ");
    expect(readConfig("CALDAV_USERNAME", { CALDAV_USERNAME: " user " })).toBe("user");
    expect(readConfig("ADMIN_EMAIL", { ADMIN_EMAIL: " admin@example.test " })).toBe(
      "admin@example.test",
    );
    for (const name of [
      "ADMIN_EMAIL",
      "CALDAV_URL",
      "CALDAV_USERNAME",
      "EMBEDDING_BASE_URL",
      "EMBEDDING_MODEL",
    ] as const)
      expect(readConfig(name, { [name]: " " })).toBe("");
    expect(readAiConfig({ EMBEDDING_BASE_URL: " " }).embedding.state).toBe("none");
  });

  it("does not let AI defaults enable an endpoint or hide explicitly set extras", () => {
    expect(readAiConfig({}).embedding.state).toBe("none");
    expect(readAiConfig({ EMBEDDING_DIMENSIONS: "" }).embedding.state).toBe("none");
    expect(readAiConfig({ EMBEDDING_DIMENSIONS: "1024" }).embedding.state).toBe("misconfigured");
    expect(readAiConfig({ GENERATION_MAX_TOKENS: "800" }).generation.state).toBe("misconfigured");
    expect(readAiConfig({ EMBEDDING_QUERY_TEMPLATE: "{text}" }).embedding.state).toBe("none");
  });

  it("keeps About metadata value-free and based on raw presence, not parsed defaults", () => {
    vi.stubEnv("REQUIRE_ADMIN_TWO_FACTOR", "false");
    expect(environmentStatus().find((v) => v.name === "REQUIRE_ADMIN_TWO_FACTOR")?.set).toBe(true);
    expect(ENVIRONMENT_VARIABLES).toHaveLength(43);
    expect(
      ENVIRONMENT_VARIABLES.every(
        (v) => Object.keys(v).sort().join() === "expectedUnset,group,name",
      ),
    ).toBe(true);
  });
});
