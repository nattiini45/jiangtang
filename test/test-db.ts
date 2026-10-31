import { execFileSync } from "node:child_process";
import { Client } from "pg";

/**
 * Isolated test database: `pnpm test` must not write to the dev
 * database. The test URL is `DATABASE_URL_TEST` when set, else the
 * `<dbname>_test` sibling of `DATABASE_URL` — the same host/credentials
 * derivation style as `deriveShadowUrl` in `prisma.config.ts`.
 *
 * The URL is derived in TWO places because vitest's `globalSetup` runs in a
 * different process than the test workers: `test/global-setup.ts` provisions
 * it (create + migrate + seed), `test/setup-env.ts` redirects the worker's
 * `process.env.DATABASE_URL` before any app module constructs the client.
 */

export function deriveTestDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  url.pathname = `/${name}_test`;
  return url.toString();
}

/**
 * Validate a PostgreSQL URL for safe test/provisioning use.
 * Rejects routing overrides, encoded hosts, sockets, maintenance databases,
 * and other forms that could bypass the disposable-server gate.
 *
 * Query keys are a CLOSED allowlist (`schema`, `sslmode`, `application_name`),
 * matched exactly. Any other key is refused — this is an allowlist, not a
 * denylist of the eight known routing keys.
 */
export function validateTestDatabaseUrl(
  url: string,
  options: { requiredSuffix?: string } = {},
): { hostname: string; port: number; database: string } {
  const { requiredSuffix } = options;

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid database URL: ${url}`);
  }

  // Require postgres protocol
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(
      `Database URL must use postgresql:// or postgres:// protocol, got ${parsed.protocol}`,
    );
  }

  // Reject socket forms (unix socket paths in hostname)
  // Check this before the empty hostname check
  if (
    parsed.hostname.startsWith("/") ||
    parsed.hostname.includes(".sock") ||
    parsed.hostname === ""
  ) {
    // Check if this looks like a socket path in the pathname
    if (url.includes("/var/run") || url.includes(".sock")) {
      throw new Error("Socket connections are not supported for test databases");
    }
  }

  // Require explicit non-empty hostname
  if (!parsed.hostname || parsed.hostname === "") {
    throw new Error("Database URL must have an explicit hostname");
  }

  // Reject encoded hostnames (e.g., %6cocalhost for localhost)
  // The hostname property is already decoded, so check if the original URL
  // contains percent-encoding in the authority section
  const authorityMatch = url.match(/\/\/([^@/]+@)?([^:/?]+)/);
  if (authorityMatch && authorityMatch[2] && authorityMatch[2].includes("%")) {
    throw new Error("Encoded hostnames are not allowed");
  }

  // Extract and validate database name
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || database === "") {
    throw new Error("Database URL must specify a database name");
  }

  // Reject encoded database paths
  if (parsed.pathname.includes("%")) {
    throw new Error("Encoded database paths are not allowed");
  }

  // Reject maintenance databases
  const maintenanceDbs = ["postgres", "template0", "template1"];
  if (maintenanceDbs.includes(database.toLowerCase())) {
    throw new Error(`Cannot use maintenance database ${database} for test provisioning`);
  }

  // Require test suffix if specified
  if (requiredSuffix && !database.endsWith(requiredSuffix)) {
    throw new Error(`Test database name must end with ${requiredSuffix}, got ${database}`);
  }

  // Extract port (default 5432)
  const port = parsed.port ? parseInt(parsed.port, 10) : 5432;

  // Validate query parameters — reject routing overrides
  const allowedQueryKeys = new Set(["schema", "sslmode", "application_name"]);
  const rejectedQueryKeys = new Set([
    "host",
    "hostaddr",
    "port",
    "user",
    "password",
    "database",
    "service",
    "options",
  ]);

  for (const [key] of parsed.searchParams.entries()) {
    // Routing overrides are refused first, case-insensitively, so `HOST` cannot
    // slip past as an "unknown" key and lose the more specific message. That
    // specific message is what makes the routing-override refusal legible.
    if (rejectedQueryKeys.has(key.toLowerCase())) {
      throw new Error(`Query parameter ${key} is not allowed (routing override)`);
    }
    // Everything else must be on the allowlist. Matched EXACTLY (case-sensitive)
    // because the allowlist is a closed set of three literal libpq keywords:
    // `Schema` is not `schema`, and an unrecognized key must fail closed rather
    // than ride along into the driver. Only `schema`, `sslmode` and
    // `application_name` are valid query keys, in both the base and override
    // URLs; every other key fails closed. The driver resolves hostnames from
    // query parameters, so a key could reroute the connection away from the
    // validated authority; an open-ended "unknown keys are fine" branch is not
    // an allowlist at all.
    if (!allowedQueryKeys.has(key)) {
      throw new Error(
        `Query parameter ${key} is not allowed (only schema, sslmode and application_name are accepted)`,
      );
    }
  }

  return { hostname: parsed.hostname, port, database };
}

/**
 * Check if two database URLs refer to the same database identity.
 * Identity is the lowercased hostname, the effective port and the decoded
 * database name; credentials and allowlisted query keys are not part of it.
 */
export function isSameDatabaseIdentity(url1: string, url2: string): boolean {
  const id1 = validateTestDatabaseUrl(url1);
  const id2 = validateTestDatabaseUrl(url2);
  return (
    id1.hostname.toLowerCase() === id2.hostname.toLowerCase() &&
    id1.port === id2.port &&
    id1.database.toLowerCase() === id2.database.toLowerCase()
  );
}

export function testDatabaseUrl(baseOverride?: string, testOverride?: string): string {
  const base = baseOverride ?? process.env.DATABASE_URL;
  const testOverride2 = testOverride ?? process.env.DATABASE_URL_TEST;

  if (testOverride2) {
    validateTestDatabaseUrl(testOverride2, { requiredSuffix: "_test" });
    // If base is also provided, ensure they're not the same identity
    if (base) {
      validateTestDatabaseUrl(base);
      if (isSameDatabaseIdentity(base, testOverride2)) {
        throw new Error("DATABASE_URL_TEST must not be the same database as DATABASE_URL");
      }
    }
    return testOverride2;
  }

  if (!base) {
    throw new Error("DATABASE_URL must be set for the DB-backed guard tests.");
  }

  validateTestDatabaseUrl(base);
  return deriveTestDatabaseUrl(base);
}

/** CREATE DATABASE if missing — connects through the `postgres` maintenance DB. */
export async function ensureTestDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const admin = new URL(url);
  admin.pathname = "/postgres";
  admin.search = "";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: number }>(
      "SELECT 1 AS exists FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`);
    }
  } finally {
    await client.end();
  }
}

/** migrate deploy + the idempotent demo seed, both pointed at the test URL. */
export function provisionTestDatabase(url: string): void {
  // The suite asserts German demo names, whatever the ambient DEFAULT_LOCALE is.
  const env = { ...process.env, DATABASE_URL: url, DEFAULT_LOCALE: "de" };
  // shell: pnpm resolves to pnpm.cmd on Windows.
  execFileSync("pnpm db:deploy", { env, stdio: "inherit", shell: true });
  execFileSync("pnpm db:seed", { env, stdio: "inherit", shell: true });
}
