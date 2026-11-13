import { FALLBACK_LOCALE, matchLocale } from "~/i18n/locales";

type Env = Readonly<Record<string, string | undefined>>;
type Group =
  | "runtime"
  | "database"
  | "auth"
  | "bootstrap"
  | "development"
  | "storage"
  | "calendar"
  | "search"
  | "embedding"
  | "rerank"
  | "generation"
  | "operations";

const rawString = (raw: string | undefined) => raw;
const nullish = <T>(raw: string | undefined, fallback: T) => raw ?? fallback;
const nonempty = <T>(raw: string | undefined, fallback: T) => raw || fallback;
const trimmed = (raw: string | undefined) => raw?.trim();
const trimmedOr = <T>(raw: string | undefined, fallback: T) => raw?.trim() || fallback;
const positiveNumber = (raw: string | undefined, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const numberOr = (raw: string | undefined, fallback: number) =>
  raw === undefined || raw.trim() === "" ? fallback : Number(raw.trim());

function variable<T>(
  group: Group,
  fallback: T,
  parse: (raw: string | undefined, fallback: T) => T,
  { secret = false, environmentOnly = false }: { secret?: boolean; environmentOnly?: boolean } = {},
) {
  return {
    group,
    default: fallback,
    parse: (raw: string | undefined) => parse(raw, fallback),
    secret,
    environmentOnly,
    expectedUnset: group === "bootstrap",
  };
}

export const CONFIG = {
  NODE_ENV: variable("runtime", undefined, rawString, { environmentOnly: true }),
  PORT: variable("runtime", 3000, (raw, fallback) => Number(raw ?? fallback), {
    environmentOnly: true,
  }),
  APP_COMMIT: variable("runtime", "unknown", nonempty, { environmentOnly: true }),
  DEFAULT_LOCALE: variable(
    "runtime",
    FALLBACK_LOCALE,
    (raw, fallback) => matchLocale(raw) ?? fallback,
  ),
  LANDING_PAGE_ENABLED: variable("runtime", false, (raw) => raw === "1"),
  DATABASE_URL: variable("database", undefined, rawString, { secret: true, environmentOnly: true }),
  BETTER_AUTH_URL: variable("auth", undefined, rawString, { environmentOnly: true }),
  BETTER_AUTH_SECRET: variable("auth", undefined, rawString, {
    secret: true,
    environmentOnly: true,
  }),
  REQUIRE_ADMIN_TWO_FACTOR: variable("auth", false, (raw) => raw === "true"),
  ADMIN_EMAIL: variable("bootstrap", undefined, trimmed, { environmentOnly: true }),
  ADMIN_PASSWORD: variable("bootstrap", undefined, rawString, {
    secret: true,
    environmentOnly: true,
  }),
  ADMIN_INITIALS: variable("bootstrap", undefined, rawString, { environmentOnly: true }),
  DEV_ADMIN_EMAIL: variable("development", "admin@jiangtang.local", nullish, {
    environmentOnly: true,
  }),
  DEV_ADMIN_PASSWORD: variable("development", "jiangtang-admin", nullish, {
    secret: true,
    environmentOnly: true,
  }),
  STORAGE_DIR: variable("storage", "./data/attachments", nullish, { environmentOnly: true }),
  STORAGE_ENCRYPTION_KEY: variable("storage", undefined, rawString, {
    secret: true,
    environmentOnly: true,
  }),
  STORAGE_KEY_SALT: variable(
    "storage",
    "jiangtang-storage-v1",
    (raw, fallback) => (raw && raw.trim().length > 0 ? raw : fallback),
    { environmentOnly: true },
  ),
  ICAL_FEED_TOKEN: variable("calendar", undefined, rawString, { secret: true }),
  CALDAV_URL: variable("calendar", undefined, trimmed, { secret: true }),
  CALDAV_USERNAME: variable("calendar", undefined, trimmed),
  CALDAV_PASSWORD: variable("calendar", undefined, rawString, { secret: true }),
  SEARCH_INDEXER: variable("search", undefined, rawString),
  EMBEDDING_BASE_URL: variable("embedding", undefined, trimmed, { secret: true }),
  EMBEDDING_MODEL: variable("embedding", undefined, trimmed),
  EMBEDDING_API_KEY: variable("embedding", undefined, (raw) => raw?.trim() || undefined, {
    secret: true,
  }),
  EMBEDDING_DIMENSIONS: variable("embedding", 1024, numberOr, { environmentOnly: true }),
  EMBEDDING_SEND_DIMENSIONS: variable("embedding", true, (raw, fallback) =>
    raw === undefined || raw.trim() === ""
      ? fallback
      : !["0", "false", "off", "no"].includes(raw.trim().toLowerCase()),
  ),
  EMBEDDING_QUERY_TEMPLATE: variable(
    "embedding",
    "Instruct: {instruction}\nQuery:{text}",
    trimmedOr,
  ),
  EMBEDDING_QUERY_INSTRUCTION: variable(
    "embedding",
    "Given a search query in an AV and facility management workspace, retrieve the records that answer the query",
    trimmedOr,
  ),
  EMBEDDING_PASSAGE_TEMPLATE: variable("embedding", "{text}", trimmedOr),
  RERANK_BASE_URL: variable("rerank", undefined, trimmed, { secret: true }),
  RERANK_MODEL: variable("rerank", undefined, trimmed),
  RERANK_API_KEY: variable("rerank", undefined, (raw) => raw?.trim() || undefined, {
    secret: true,
  }),
  GENERATION_BASE_URL: variable("generation", undefined, trimmed, { secret: true }),
  GENERATION_MODEL: variable("generation", undefined, trimmed),
  GENERATION_API_KEY: variable("generation", undefined, (raw) => raw?.trim() || undefined, {
    secret: true,
  }),
  GENERATION_MAX_TOKENS: variable("generation", 800, numberOr),
  GENERATION_SYSTEM_ROLE: variable(
    "generation",
    "system",
    (raw, fallback) => raw?.trim().toLowerCase() || fallback,
  ),
  LOG_LEVEL: variable("operations", "info", nullish, { environmentOnly: true }),
  GLITCHTIP_DSN: variable("operations", undefined, rawString, {
    secret: true,
    environmentOnly: true,
  }),
  ACTIVITY_RETENTION_DAYS: variable("operations", 2555, positiveNumber, { environmentOnly: true }),
  FUNCTION_CONFIRMATION_DAYS: variable("operations", 200, positiveNumber, {
    environmentOnly: true,
  }),
  WARRANTY_WINDOW_DAYS: variable("operations", 30, positiveNumber),
} as const;

export type ConfigName = keyof typeof CONFIG;
export const CONFIG_REGISTRY = Object.entries(CONFIG).map(([name, definition]) => ({
  name: name as ConfigName,
  ...definition,
}));

export function readRawConfig(name: ConfigName, env: Env = process.env): string | undefined {
  return env[name];
}

export function readConfig<K extends ConfigName>(
  name: K,
  env?: Env,
): ReturnType<(typeof CONFIG)[K]["parse"]> {
  return CONFIG[name].parse(readRawConfig(name, env)) as ReturnType<(typeof CONFIG)[K]["parse"]>;
}

export function setRuntimeNodeEnv(value: "development" | "production"): void {
  process.env.NODE_ENV = value;
}
