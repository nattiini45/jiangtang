const groups = {
  runtime: ["NODE_ENV", "PORT", "APP_COMMIT", "DEFAULT_LOCALE", "LANDING_PAGE_ENABLED"],
  database: ["DATABASE_URL"],
  auth: ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "REQUIRE_ADMIN_TWO_FACTOR"],
  bootstrap: ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_INITIALS"],
  development: ["DEV_ADMIN_EMAIL", "DEV_ADMIN_PASSWORD"],
  storage: ["STORAGE_DIR", "STORAGE_ENCRYPTION_KEY", "STORAGE_KEY_SALT"],
  calendar: ["ICAL_FEED_TOKEN", "CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD"],
  search: ["SEARCH_INDEXER"],
  embedding: [
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "EMBEDDING_API_KEY",
    "EMBEDDING_DIMENSIONS",
    "EMBEDDING_SEND_DIMENSIONS",
    "EMBEDDING_QUERY_TEMPLATE",
    "EMBEDDING_QUERY_INSTRUCTION",
    "EMBEDDING_PASSAGE_TEMPLATE",
  ],
  rerank: ["RERANK_BASE_URL", "RERANK_MODEL", "RERANK_API_KEY"],
  generation: [
    "GENERATION_BASE_URL",
    "GENERATION_MODEL",
    "GENERATION_API_KEY",
    "GENERATION_MAX_TOKENS",
    "GENERATION_SYSTEM_ROLE",
  ],
  operations: ["LOG_LEVEL", "GLITCHTIP_DSN", "ACTIVITY_RETENTION_DAYS", "WARRANTY_WINDOW_DAYS"],
} as const;

export const ENVIRONMENT_VARIABLES = Object.entries(groups).flatMap(([group, names]) =>
  names.map((name) => ({
    name,
    group: group as keyof typeof groups,
    expectedUnset: group === "bootstrap",
  })),
);

export function environmentStatus() {
  return ENVIRONMENT_VARIABLES.map((variable) => ({
    ...variable,
    set: Boolean(process.env[variable.name]),
  }));
}
