import { inject } from "vitest";

// This worker deliberately does NOT read an ambient `.env`.
// The Node env-file loader call that used to sit here — wrapped in a
// try/catch that swallowed its failure — has been DELETED. The test environment
// must be explicitly constructed rather than inherited from whatever `.env`
// happens to sit in the cwd. The caller owns that construction: it passes a
// fixed set of names and refuses to start at all if a `.env` file exists.
//
// Removing the call is not cosmetic. The env-file loader does not override a
// variable that is already set, but it DOES add absent names — so it could
// inject exactly the names the caller omits on purpose (proxy and provider
// credentials) into every Vitest worker.
//
// The environment must therefore be SUPPLIED to the test run; the caller
// supplies it. Nothing is read here as a fallback, and nothing else in this file
// depended on the removed try/catch: the only other input is
// `inject("testDatabaseUrl")`, which fails closed below when absent.
//
// NOTE: the removed API is intentionally not named in this comment, so that the
// structural grep for it over this directory stays empty and remains a
// machine-checkable proof that no such call survives here. Do not re-add the
// call, and do not name it in prose.

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
