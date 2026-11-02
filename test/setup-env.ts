import { inject } from "vitest";

// Each Vitest worker does not read a `.env` file: the test environment is the one
// the process was started with. An env-file loader would add every name the
// caller left out, including proxy and provider credentials, to every worker.
// Nothing is read here as a fallback; the only other input is
// `inject("testDatabaseUrl")`, which fails closed below when it is absent.

// Receive the validated test database URL from global-setup via Vitest's inject mechanism.
// This ensures exactly-once distribution with no re-derivation or double suffix.
const testDbUrl = inject("testDatabaseUrl");

if (!testDbUrl) {
  throw new Error("testDatabaseUrl not provided by global-setup — Vitest provide/inject failed");
}

// Redirect this worker to the isolated test database BEFORE any test file import
// constructs the Prisma client. Dev server and e2e keep the real DATABASE_URL.
process.env.DATABASE_URL = testDbUrl;

// The suite asserts German copy; pin the workspace default so a developer's or
// CI's ambient DEFAULT_LOCALE cannot change what the tests render.
process.env.DEFAULT_LOCALE = "de";
