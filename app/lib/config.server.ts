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
  secret = false,
  environmentOnly = false,
  about = true,
) {
  return {
    group,
    default: fallback,
    parse: (raw: string | undefined) => parse(raw, fallback),
    secret,
    environmentOnly,
    about,
    expectedUnset: group === "bootstrap",
  };
}

export const CONFIG = {
  NODE_ENV: variable("runtime", undefined, rawString, false, true),
  PORT: variable("runtime", 3000, (raw, fallback) => Number(raw ?? fallback), false, true),
  APP_COMMIT: variable("runtime", "unknown", nonempty),
  DEFAULT_LOCALE: variable(
    "runtime",
    FALLBACK_LOCALE,
    (raw, fallback) => matchLocale(raw) ?? fallback,
  ),
  LANDING_PAGE_ENABLED: variable("runtime", false, (raw) => raw === "1"),
  DATABASE_URL: variable("database", undefined, rawString, true, true),
  BETTER_AUTH_URL: variable("auth", undefined, rawString, false, true),
  BETTER_AUTH_SECRET: variable("auth", undefined, rawString, true, true),
  REQUIRE_ADMIN_TWO_FACTOR: variable("auth", false, (raw) => raw === "true"),
  ADMIN_EMAIL: variable("bootstrap", undefined, trimmed, false, true),
  ADMIN_PASSWORD: variable("bootstrap", undefined, rawString, true, true),
  ADMIN_INITIALS: variable("bootstrap", undefined, rawString, false, true),
  DEV_ADMIN_EMAIL: variable("development", "admin@jiangtang.local", nullish, false, true),
  DEV_ADMIN_PASSWORD: variable("development", "jiangtang-admin", nullish, true, true),
  STORAGE_DIR: variable("storage", "./data/attachments", nullish, false, true),
  STORAGE_ENCRYPTION_KEY: variable("storage", undefined, rawString, true, true),
  STORAGE_KEY_SALT: variable(
    "storage",
    "jiangtang-storage-v1",
    (raw, fallback) => (raw && raw.trim().length > 0 ? raw : fallback),
    false,
    true,
  ),
  ICAL_FEED_TOKEN: variable("calendar", undefined, rawString, true),
  CALDAV_URL: variable("calendar", undefined, trimmed, true),
  CALDAV_USERNAME: variable("calendar", undefined, trimmed),
  CALDAV_PASSWORD: variable("calendar", undefined, rawString, true),
  SEARCH_INDEXER: variable("search", undefined, rawString),
  EMBEDDING_BASE_URL: variable("embedding", undefined, trimmed, true),
  EMBEDDING_MODEL: variable("embedding", undefined, trimmed),
  EMBEDDING_API_KEY: variable("embedding", undefined, (raw) => raw?.trim() || undefined, true),
  EMBEDDING_DIMENSIONS: variable("embedding", 1024, numberOr, false, true),
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
  RERANK_BASE_URL: variable("rerank", undefined, trimmed, true),
  RERANK_MODEL: variable("rerank", undefined, trimmed),
  RERANK_API_KEY: variable("rerank", undefined, (raw) => raw?.trim() || undefined, true),
  GENERATION_BASE_URL: variable("generation", undefined, trimmed, true),
  GENERATION_MODEL: variable("generation", undefined, trimmed),
  GENERATION_API_KEY: variable("generation", undefined, (raw) => raw?.trim() || undefined, true),
  GENERATION_MAX_TOKENS: variable("generation", 800, numberOr),
  GENERATION_SYSTEM_ROLE: variable(
    "generation",
    "system",
    (raw, fallback) => raw?.trim().toLowerCase() || fallback,
  ),
  LOG_LEVEL: variable("operations", "info", nullish, false, true),
  GLITCHTIP_DSN: variable("operations", undefined, rawString, true, true),
  ACTIVITY_RETENTION_DAYS: variable("operations", 2555, positiveNumber, false, true),
  WARRANTY_WINDOW_DAYS: variable("operations", 30, positiveNumber),
  TZ: variable("runtime", undefined, rawString, false, true, false),
  ALERT_WEBHOOK: variable("operations", undefined, rawString, true, true, false),
  WALG_S3_PREFIX: variable("operations", undefined, rawString, false, true, false),
  AWS_ACCESS_KEY_ID: variable("operations", undefined, rawString, true, true, false),
  AWS_SECRET_ACCESS_KEY: variable("operations", undefined, rawString, true, true, false),
  AWS_ENDPOINT: variable("operations", "", nonempty, false, true, false),
  AWS_REGION: variable("operations", "eu-central-1", nonempty, false, true, false),
  WALG_RETENTION_COUNT: variable("operations", "7", nullish, false, true, false),
  WALG_DISK_CAPACITY: variable("operations", "10GB", nonempty, false, true, false),
  RESTORE_DRILL_ENABLED: variable("operations", false, (raw) => Boolean(raw), false, true, false),
  BACKUP_STATUS_DIR: variable("operations", "/backup-status", nonempty, false, true, false),
  ALERT_STATE_DIR: variable("operations", "/tmp/backup-alert-state", nonempty, false, true, false),
  REALERT_SECONDS: variable("operations", "21600", nonempty, false, true, false),
  BACKUP_MAX_AGE_SECONDS: variable("operations", "129600", nonempty, false, true, false),
  HEALTH_URL: variable("operations", "http://app:3000/healthz", nonempty, false, true, false),
  TIMEOUT: variable("operations", "5", nonempty, false, true, false),
  UPLOADS_DIR: variable("operations", "/uploads", nonempty, false, true, false),
  UPLOADS_RETENTION_COUNT: variable("operations", "14", nullish, false, true, false),
  PGDATA: variable("operations", undefined, rawString, false, true, false),
  PGDATA_MOUNT: variable("operations", "/var/lib/postgresql", nonempty, false, true, false),
  PGDATABASE: variable("operations", undefined, rawString, false, true, false),
  PGUSER: variable("operations", undefined, rawString, false, true, false),
  PGPASSWORD: variable("operations", undefined, rawString, true, true, false),
  RESTORE_CONFIRM: variable("operations", undefined, rawString, false, true, false),
  TARGET_TS: variable("operations", "", nonempty, false, true, false),
  BACKUP_NAME: variable("operations", "", nonempty, false, true, false),
  DRILL_PORT: variable("operations", "5433", nonempty, false, true, false),
  TMPDIR: variable("operations", "/tmp", nonempty, false, true, false),
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
