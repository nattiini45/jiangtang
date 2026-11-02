import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import {
  deriveTestDatabaseUrl,
  ensureTestDatabase,
  isSameDatabaseIdentity,
  provisionTestDatabase,
  testDatabaseUrl,
  validateTestDatabaseUrl,
} from "./test-db";
import globalSetup from "./global-setup";

// ---------------------------------------------------------------------------
// Mock layer proving that every refusal happens before connection or
// provisioning, and that invalid input calls neither provisioning function.
//
// `vi.hoisted` is REQUIRED here: `vi.mock` factories are hoisted above the
// module body, so a factory closing over a plain `const spy = vi.fn()` dies with
// "ReferenceError: spy is not defined". Declaring the spies inside `vi.hoisted`
// puts them in the hoisted scope too. (Deleting the mocks instead of hoisting
// them produces the same error; the fix is hoisting, not removal.)
//
// Nothing below touches a database: `pg`'s Client constructor and
// `node:child_process`'s execFileSync are both replaced by spies, so a "pass"
// here is proof that no connection or provisioning subprocess was even
// attempted, not merely that none succeeded.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const Client = vi.fn((config: unknown) => ({
    config,
    connect: vi.fn(async () => undefined),
    // `rows: [{ exists: 1 }]` keeps `ensureTestDatabase` on its "already there"
    // branch, so no CREATE DATABASE string is built either.
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ exists: 1 }],
    })),
    end: vi.fn(async () => undefined),
  }));
  const execFileSync = vi.fn((_cmd: string, _opts?: unknown) => "");
  return { Client, execFileSync };
});

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, Client: h.Client };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, execFileSync: h.execFileSync };
});

// Shapes only the constructor/query call sites need, read back off the spies.
type ClientConfig = { connectionString: string };
type ClientInstance = {
  connect: { mock: { calls: unknown[][] } };
  query: { mock: { calls: Array<[string, unknown[] | undefined]> } };
  end: { mock: { calls: unknown[][] } };
};

const clientConfig = (callIndex = 0): ClientConfig =>
  h.Client.mock.calls[callIndex][0] as ClientConfig;
const clientInstance = (callIndex = 0): ClientInstance =>
  h.Client.mock.results[callIndex].value as ClientInstance;

/** Synthetic literals — invented for these tests, not real QA credentials. */
const SYNTH_BASE = "postgresql://synthetic_user:synthetic_pass@127.0.0.1:55432/jiangtang_qa";
const SYNTH_TEST = "postgresql://synthetic_user:synthetic_pass@127.0.0.1:55432/jiangtang_qa_test";

function clearProvisioningSpies(): void {
  h.Client.mockClear();
  h.execFileSync.mockClear();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("vitest");
  vi.resetModules();
  clearProvisioningSpies();
});

describe("validateTestDatabaseUrl", () => {
  it("accepts valid postgresql URL with explicit hostname", () => {
    const result = validateTestDatabaseUrl("postgresql://user:pass@localhost:5432/mydb_test");
    expect(result).toEqual({
      hostname: "localhost",
      port: 5432,
      database: "mydb_test",
    });
  });

  it("accepts postgres protocol", () => {
    const result = validateTestDatabaseUrl("postgres://localhost/mydb_test");
    expect(result.database).toBe("mydb_test");
  });

  it("uses default port 5432 when not specified", () => {
    const result = validateTestDatabaseUrl("postgresql://localhost/mydb_test");
    expect(result.port).toBe(5432);
  });

  it("accepts explicit non-default port", () => {
    const result = validateTestDatabaseUrl("postgresql://localhost:55432/mydb_test");
    expect(result.port).toBe(55432);
  });

  it("accepts allowed query parameters", () => {
    const result = validateTestDatabaseUrl(
      "postgresql://localhost/mydb_test?schema=public&sslmode=require&application_name=test",
    );
    expect(result.database).toBe("mydb_test");
  });

  it("rejects invalid protocol", () => {
    expect(() => validateTestDatabaseUrl("mysql://localhost/mydb_test")).toThrow(
      "must use postgresql:// or postgres://",
    );
  });

  it("rejects socket connections", () => {
    expect(() => validateTestDatabaseUrl("postgresql:///var/run/postgresql/mydb_test")).toThrow(
      "Socket connections are not supported",
    );
  });

  it("rejects socket hostname with .sock", () => {
    expect(() =>
      validateTestDatabaseUrl("postgresql://user@%2Fvar%2Frun%2Fpostgres.sock/mydb"),
    ).toThrow("Socket connections are not supported");
  });

  it("rejects empty hostname", () => {
    expect(() => validateTestDatabaseUrl("postgresql:///mydb_test")).toThrow(
      "must have an explicit hostname",
    );
  });

  it("rejects encoded hostname", () => {
    // %6cocalhost decodes to "localhost" but should be rejected
    expect(() => validateTestDatabaseUrl("postgresql://%6cocalhost/mydb_test")).toThrow(
      "Encoded hostnames are not allowed",
    );
  });

  it("rejects empty database name", () => {
    expect(() => validateTestDatabaseUrl("postgresql://localhost/")).toThrow(
      "must specify a database name",
    );
  });

  it("rejects encoded database path", () => {
    expect(() => validateTestDatabaseUrl("postgresql://localhost/my%64b")).toThrow(
      "Encoded database paths are not allowed",
    );
  });

  it("rejects maintenance database 'postgres'", () => {
    expect(() => validateTestDatabaseUrl("postgresql://localhost/postgres")).toThrow(
      "Cannot use maintenance database",
    );
  });

  it("rejects maintenance database 'template0'", () => {
    expect(() => validateTestDatabaseUrl("postgresql://localhost/template0")).toThrow(
      "Cannot use maintenance database",
    );
  });

  it("rejects maintenance database 'template1'", () => {
    expect(() => validateTestDatabaseUrl("postgresql://localhost/template1")).toThrow(
      "Cannot use maintenance database",
    );
  });

  it("rejects query parameter 'host' (routing override)", () => {
    expect(() => validateTestDatabaseUrl("postgresql://localhost/mydb_test?host=evil.com")).toThrow(
      "Query parameter host is not allowed",
    );
  });

  it("rejects query parameter 'hostaddr' (routing override)", () => {
    expect(() =>
      validateTestDatabaseUrl("postgresql://localhost/mydb_test?hostaddr=1.2.3.4"),
    ).toThrow("Query parameter hostaddr is not allowed");
  });

  it("rejects query parameter 'port' (routing override)", () => {
    expect(() => validateTestDatabaseUrl("postgresql://localhost/mydb_test?port=9999")).toThrow(
      "Query parameter port is not allowed",
    );
  });

  it("rejects query parameter 'user' (routing override)", () => {
    expect(() => validateTestDatabaseUrl("postgresql://localhost/mydb_test?user=admin")).toThrow(
      "Query parameter user is not allowed",
    );
  });

  it("rejects query parameter 'password' (routing override)", () => {
    expect(() =>
      validateTestDatabaseUrl("postgresql://localhost/mydb_test?password=secret"),
    ).toThrow("Query parameter password is not allowed");
  });

  it("rejects query parameter 'database' (routing override)", () => {
    expect(() =>
      validateTestDatabaseUrl("postgresql://localhost/mydb_test?database=otherdb"),
    ).toThrow("Query parameter database is not allowed");
  });

  it("requires _test suffix when specified", () => {
    expect(() =>
      validateTestDatabaseUrl("postgresql://localhost/mydb", {
        requiredSuffix: "_test",
      }),
    ).toThrow("must end with _test");
  });

  it("accepts _test suffix when required", () => {
    const result = validateTestDatabaseUrl("postgresql://localhost/mydb_test", {
      requiredSuffix: "_test",
    });
    expect(result.database).toBe("mydb_test");
  });
});

// ---------------------------------------------------------------------------
// The URL validator accepts query keys ONLY `schema`, `sslmode` and
// `application_name`; every other key is rejected in both base and override
// URLs. The original implementation was a denylist of eight routing keys with an EMPTY
// else-branch, so `foo`, `target_session_attrs`, `load_balance_hosts`,
// `sslrootcert`, `sslcert` and `sslkey` were all accepted. These cases are the
// regression guard for that, and they keep the routing keys' more specific
// message distinct from the generic unknown-key message.
// ---------------------------------------------------------------------------
describe("query-key allowlist accepts ONLY schema/sslmode/application_name", () => {
  const url = (query: string) =>
    `postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?${query}`;

  for (const key of ["schema", "sslmode", "application_name"]) {
    it(`accepts the allowlisted key '${key}'`, () => {
      expect(validateTestDatabaseUrl(url(`${key}=v`)).database).toBe("jiangtang_qa_test");
    });
  }

  // Query keys the validator must reject.
  for (const key of [
    "foo",
    "target_session_attrs",
    "load_balance_hosts",
    "sslrootcert",
    "sslcert",
    "sslkey",
  ]) {
    it(`rejects unknown query key '${key}' and names it in the message`, () => {
      let caught: Error | undefined;
      try {
        validateTestDatabaseUrl(url(`${key}=v`));
      } catch (e) {
        caught = e as Error;
      }
      expect(caught, `'${key}' must be refused`).toBeInstanceOf(Error);
      expect(caught?.message).toContain(`Query parameter ${key} is not allowed`);
      expect(caught?.message).toContain("only schema, sslmode and application_name are accepted");
    });
  }

  // Further libpq keywords that are NOT on the allowlist. Several of these
  // (sslfactory, channel_binding, krbsrvname, replication) change driver
  // behaviour, which is why an open else-branch was unsafe.
  for (const key of [
    "sslfactory",
    "sslpassword",
    "channel_binding",
    "connect_timeout",
    "krbsrvname",
    "replication",
    "gssencmode",
    "prefer",
  ]) {
    it(`rejects non-allowlisted libpq keyword '${key}'`, () => {
      expect(() => validateTestDatabaseUrl(url(`${key}=v`))).toThrow(
        `Query parameter ${key} is not allowed`,
      );
    });
  }

  it("matches the allowlist exactly, so case-evasion 'Schema' is refused", () => {
    // `Schema` is not one of the three literal allowlisted keys. Refusing it is
    // strictly safer than normalizing case on the way IN: an unrecognized key
    // must fail closed rather than ride along into the driver. Verified that no
    // real URL in this repository uses a capitalized query key — the only key
    // any real DATABASE_URL carries is `schema` (.env.example, ci.yml,
    // docker-compose.yml).
    expect(() => validateTestDatabaseUrl(url("Schema=public"))).toThrow(
      "Query parameter Schema is not allowed",
    );
    expect(() => validateTestDatabaseUrl(url("SSLMODE=require"))).toThrow(
      "Query parameter SSLMODE is not allowed",
    );
  });

  it("still gives the eight routing keys their OWN specific message", () => {
    // the two refusal cases must not be collapsed into one generic
    // error, because the routing-specific message is what makes the
    // override refusal legible.
    for (const key of [
      "host",
      "hostaddr",
      "port",
      "user",
      "password",
      "database",
      "service",
      "options",
    ]) {
      let caught: Error | undefined;
      try {
        validateTestDatabaseUrl(url(`${key}=x`));
      } catch (e) {
        caught = e as Error;
      }
      expect(caught?.message).toBe(`Query parameter ${key} is not allowed (routing override)`);
      expect(caught?.message).not.toContain(
        "only schema, sslmode and application_name are accepted",
      );
    }
  });

  it("routing-key refusal is case-insensitive, so 'HOST' cannot dodge it", () => {
    expect(() => validateTestDatabaseUrl(url("HOST=evil.invalid"))).toThrow(
      "Query parameter HOST is not allowed (routing override)",
    );
  });

  it("the generic and routing messages are DIFFERENT strings (not collapsed)", () => {
    let generic = "";
    let routing = "";
    try {
      validateTestDatabaseUrl(url("foo=v"));
    } catch (e) {
      generic = (e as Error).message;
    }
    try {
      validateTestDatabaseUrl(url("host=evil.invalid"));
    } catch (e) {
      routing = (e as Error).message;
    }
    expect(generic).not.toBe("");
    expect(routing).not.toBe("");
    expect(generic).not.toBe(routing);
  });

  it("rejects an unknown key in the BASE url reached through testDatabaseUrl", () => {
    expect(() =>
      testDatabaseUrl("postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa?foo=v", undefined),
    ).toThrow("Query parameter foo is not allowed");
  });

  it("rejects an unknown key in the OVERRIDE url ('in both base and override URLs')", () => {
    expect(() =>
      testDatabaseUrl(
        SYNTH_BASE,
        "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?sslrootcert=/etc/x",
      ),
    ).toThrow("Query parameter sslrootcert is not allowed");
  });

  it("rejects a routing key in the OVERRIDE url too", () => {
    expect(() =>
      testDatabaseUrl(
        SYNTH_BASE,
        "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?host=evil.invalid",
      ),
    ).toThrow("Query parameter host is not allowed (routing override)");
  });
});

// ---------------------------------------------------------------------------
// the missing differential: encoded ordinary hostname `%6cocalhost` versus
// literal `localhost` on the SAME `_test` database. The pg driver decodes hosts,
// so comparison alone is insufficient — encoded forms must be REJECTED, not
// silently normalized into a comparison that reports "same database".
// ---------------------------------------------------------------------------
describe("encoded %6cocalhost vs literal localhost on the same _test database", () => {
  const ENCODED = "postgresql://synthetic_user@%6cocalhost:55432/jiangtang_qa_test";
  const LITERAL = "postgresql://synthetic_user@localhost:55432/jiangtang_qa_test";
  const ENCODED_BASE = "postgresql://synthetic_user@%6cocalhost:55432/jiangtang_qa";

  it("refuses the encoded authority outright", () => {
    expect(() => validateTestDatabaseUrl(ENCODED)).toThrow("Encoded hostnames are not allowed");
  });

  it("accepts the literal authority it decodes to (the differential control)", () => {
    expect(validateTestDatabaseUrl(LITERAL)).toEqual({
      hostname: "localhost",
      port: 55432,
      database: "jiangtang_qa_test",
    });
  });

  it("isSameDatabaseIdentity THROWS on the encoded form instead of returning true", () => {
    // The dangerous outcome would be `true` (encoded host normalized to
    // localhost, compared equal). Assert the error IDENTITY, not just "threw".
    let caught: Error | undefined;
    try {
      isSameDatabaseIdentity(ENCODED, LITERAL);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toBe("Encoded hostnames are not allowed");
  });

  it("isSameDatabaseIdentity THROWS whichever side carries the encoding", () => {
    for (const pair of [
      [ENCODED, LITERAL],
      [LITERAL, ENCODED],
      [ENCODED, ENCODED],
    ] as Array<[string, string]>) {
      expect(() => isSameDatabaseIdentity(pair[0], pair[1])).toThrow(
        "Encoded hostnames are not allowed",
      );
    }
  });

  it("testDatabaseUrl refuses the encoded OVERRIDE with the encoding error, not the identity error", () => {
    let caught: Error | undefined;
    try {
      testDatabaseUrl(ENCODED_BASE, ENCODED);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toBe("Encoded hostnames are not allowed");
    expect(caught?.message).not.toContain("must not be the same database");
  });

  it("literal-vs-literal on the SAME database produces a DIFFERENT error identity", () => {
    // Same two databases, encoded vs literal: different failure reasons. That
    // difference is the proof that the encoded form is rejected rather than
    // normalized and then compared.
    expect(isSameDatabaseIdentity(LITERAL, LITERAL)).toBe(true);
    expect(() => testDatabaseUrl(LITERAL, LITERAL)).toThrow(
      "DATABASE_URL_TEST must not be the same database as DATABASE_URL",
    );
  });

  it("testDatabaseUrl refuses an encoded BASE url on the derivation path", () => {
    expect(() => testDatabaseUrl(ENCODED_BASE, undefined)).toThrow(
      "Encoded hostnames are not allowed",
    );
  });

  it("refuses an encoded database pathname at the testDatabaseUrl level too", () => {
    expect(() =>
      testDatabaseUrl(
        "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa",
        "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa%5Ftest",
      ),
    ).toThrow("Encoded database paths are not allowed");
  });

  it("refuses an encoded socket host", () => {
    expect(() =>
      testDatabaseUrl(
        SYNTH_BASE,
        "postgresql://synthetic_user@%2Fvar%2Frun%2Fpostgres.sock/jiangtang_qa_test",
      ),
    ).toThrow();
  });
});

describe("isSameDatabaseIdentity", () => {
  it("returns true for identical URLs", () => {
    expect(
      isSameDatabaseIdentity(
        "postgresql://localhost:5432/mydb",
        "postgresql://localhost:5432/mydb",
      ),
    ).toBe(true);
  });

  it("returns true for same identity with different credentials", () => {
    expect(
      isSameDatabaseIdentity(
        "postgresql://user1:pass1@localhost:5432/mydb",
        "postgresql://user2:pass2@localhost:5432/mydb",
      ),
    ).toBe(true);
  });

  it("returns true for same identity with different allowed query params", () => {
    expect(
      isSameDatabaseIdentity(
        "postgresql://localhost:5432/mydb?schema=public",
        "postgresql://localhost:5432/mydb?application_name=test",
      ),
    ).toBe(true);
  });

  it("returns true for explicit vs default port", () => {
    expect(
      isSameDatabaseIdentity("postgresql://localhost:5432/mydb", "postgresql://localhost/mydb"),
    ).toBe(true);
  });

  it("returns true for case-insensitive hostname match", () => {
    expect(
      isSameDatabaseIdentity("postgresql://LOCALHOST/mydb", "postgresql://localhost/mydb"),
    ).toBe(true);
  });

  it("returns true for case-insensitive database match", () => {
    expect(
      isSameDatabaseIdentity("postgresql://localhost/MYDB", "postgresql://localhost/mydb"),
    ).toBe(true);
  });

  it("returns false for different hostnames", () => {
    expect(isSameDatabaseIdentity("postgresql://host1/mydb", "postgresql://host2/mydb")).toBe(
      false,
    );
  });

  it("returns false for different ports", () => {
    expect(
      isSameDatabaseIdentity(
        "postgresql://localhost:5432/mydb",
        "postgresql://localhost:5433/mydb",
      ),
    ).toBe(false);
  });

  it("returns false for different databases", () => {
    expect(isSameDatabaseIdentity("postgresql://localhost/db1", "postgresql://localhost/db2")).toBe(
      false,
    );
  });
});

describe("testDatabaseUrl", () => {
  it("derives _test sibling from base URL", () => {
    // Clear DATABASE_URL_TEST to force derivation from base
    const originalTest = process.env.DATABASE_URL_TEST;
    delete process.env.DATABASE_URL_TEST;

    try {
      const result = testDatabaseUrl("postgresql://localhost/mydb", undefined);
      expect(result).toBe("postgresql://localhost/mydb_test");
    } finally {
      if (originalTest) process.env.DATABASE_URL_TEST = originalTest;
    }
  });

  it("returns test override when provided", () => {
    const result = testDatabaseUrl(
      "postgresql://localhost/mydb",
      "postgresql://localhost/mydb_test",
    );
    expect(result).toBe("postgresql://localhost/mydb_test");
  });

  it("rejects test override without _test suffix", () => {
    expect(() =>
      testDatabaseUrl("postgresql://localhost/mydb", "postgresql://localhost/other"),
    ).toThrow("must end with _test");
  });

  it("rejects test override with same identity as base", () => {
    expect(() =>
      testDatabaseUrl(
        "postgresql://user1:pass1@localhost/mydb_test",
        "postgresql://user2:pass2@localhost/mydb_test",
      ),
    ).toThrow("must not be the same database");
  });

  it("throws when base is missing", () => {
    // Clear environment variables for this test
    const originalBase = process.env.DATABASE_URL;
    const originalTest = process.env.DATABASE_URL_TEST;
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_TEST;

    try {
      expect(() => testDatabaseUrl(undefined, undefined)).toThrow("DATABASE_URL must be set");
    } finally {
      // Restore environment variables
      if (originalBase) process.env.DATABASE_URL = originalBase;
      if (originalTest) process.env.DATABASE_URL_TEST = originalTest;
    }
  });

  it("validates base URL before deriving", () => {
    expect(() => testDatabaseUrl("mysql://localhost/mydb", undefined)).toThrow(
      "must use postgresql://",
    );
  });
});

describe("deriveTestDatabaseUrl", () => {
  it("appends _test to database name", () => {
    expect(deriveTestDatabaseUrl("postgresql://localhost/mydb")).toBe(
      "postgresql://localhost/mydb_test",
    );
  });

  it("preserves credentials and port", () => {
    expect(deriveTestDatabaseUrl("postgresql://user:pass@localhost:55432/mydb")).toBe(
      "postgresql://user:pass@localhost:55432/mydb_test",
    );
  });

  it("handles already-suffixed names by adding another _test", () => {
    expect(deriveTestDatabaseUrl("postgresql://localhost/mydb_test")).toBe(
      "postgresql://localhost/mydb_test_test",
    );
  });
});

// ---------------------------------------------------------------------------
// Every refusal must occur before connection or provisioning, proved with
// mocks. Every case asserts BOTH that the refusal happened AND that neither `pg`'s
// Client constructor nor `execFileSync` was reached. The positive control at the
// end proves those two assertions are capable of failing.
// ---------------------------------------------------------------------------
describe("every refusal happens before any connection or provisioning (mocks)", () => {
  const REFUSALS: Array<{
    label: string;
    base: string | undefined;
    test: string | undefined;
    message: string | RegExp;
  }> = [
    {
      label: "invalid protocol",
      base: "mysql://127.0.0.1:55432/jiangtang_qa",
      test: undefined,
      message: "must use postgresql:// or postgres://",
    },
    {
      label: "absent hostname",
      base: "postgresql:///jiangtang_qa_test",
      test: undefined,
      message: "must have an explicit hostname",
    },
    {
      label: "socket form",
      base: "postgresql:///var/run/postgresql/jiangtang_qa_test",
      test: undefined,
      message: "Socket connections are not supported",
    },
    {
      label: "encoded ordinary hostname",
      base: "postgresql://%6cocalhost:55432/jiangtang_qa",
      test: undefined,
      message: "Encoded hostnames are not allowed",
    },
    {
      label: "encoded database pathname",
      base: "postgresql://127.0.0.1:55432/jiangtang%5Fqa",
      test: undefined,
      message: "Encoded database paths are not allowed",
    },
    {
      label: "empty database name",
      base: "postgresql://127.0.0.1:55432/",
      test: undefined,
      message: "must specify a database name",
    },
    {
      label: "maintenance database postgres",
      base: "postgresql://127.0.0.1:55432/postgres",
      test: undefined,
      message: "Cannot use maintenance database",
    },
    {
      label: "override missing the _test suffix",
      base: SYNTH_BASE,
      test: "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_other",
      message: "must end with _test",
    },
    {
      label: "query routing override host",
      base: SYNTH_BASE,
      test: "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?host=evil.invalid",
      message: "Query parameter host is not allowed (routing override)",
    },
    {
      label: "query routing override port",
      base: SYNTH_BASE,
      test: "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?port=1",
      message: "Query parameter port is not allowed (routing override)",
    },
    {
      label: "unknown query key foo",
      base: SYNTH_BASE,
      test: "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?foo=bar",
      message: "Query parameter foo is not allowed",
    },
    {
      label: "unknown query key sslrootcert",
      base: SYNTH_BASE,
      test: "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?sslrootcert=/x",
      message: "Query parameter sslrootcert is not allowed",
    },
    {
      label: "override identity equal to source",
      base: SYNTH_TEST,
      test: "postgresql://other_user:other_pass@127.0.0.1:55432/jiangtang_qa_test",
      message: "must not be the same database",
    },
    {
      label: "missing base entirely",
      base: "",
      test: "",
      message: "DATABASE_URL must be set",
    },
  ];

  for (const c of REFUSALS) {
    it(`refuses ${c.label} with no Client constructed and no execFileSync call`, () => {
      clearProvisioningSpies();
      vi.stubEnv("DATABASE_URL", c.base ?? "");
      vi.stubEnv("DATABASE_URL_TEST", c.test ?? "");

      // Call it exactly the way test/global-setup.ts does: no arguments, so the
      // ambient (stubbed) environment is the input.
      expect(() => testDatabaseUrl(), c.label).toThrow(c.message);

      expect(h.Client, `${c.label}: pg Client must never be constructed`).not.toHaveBeenCalled();
      expect(h.execFileSync, `${c.label}: execFileSync must never run`).not.toHaveBeenCalled();
    });
  }

  it("POSITIVE CONTROL: the same spies DO record when provisioning is allowed", () => {
    // Without this, "not.toHaveBeenCalled()" above could pass against a
    // mis-wired mock. Drive both provisioning functions with a valid URL and
    // require the spies to light up.
    clearProvisioningSpies();
    vi.stubEnv("DATABASE_URL", SYNTH_BASE);
    vi.stubEnv("DATABASE_URL_TEST", SYNTH_TEST);

    const validated = testDatabaseUrl();
    expect(validated).toBe(SYNTH_TEST);

    provisionTestDatabase(validated);
    expect(h.execFileSync).toHaveBeenCalledTimes(2);

    return ensureTestDatabase(validated).then(() => {
      expect(h.Client).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Both provisioning calls must receive the validated URL, worker setup must
// receive the same value, and invalid input must call neither function.
//
// These cases call both, through the real global setup.
// ---------------------------------------------------------------------------
describe("provisioning functions receive the validated URL (mocks)", () => {
  beforeEach(() => {
    clearProvisioningSpies();
    vi.stubEnv("DATABASE_URL", SYNTH_BASE);
    vi.stubEnv("DATABASE_URL_TEST", SYNTH_TEST);
  });

  it("ensureTestDatabase receives the validated URL and probes the validated name", async () => {
    const validated = testDatabaseUrl();
    await ensureTestDatabase(validated);

    expect(h.Client).toHaveBeenCalledTimes(1);
    // The admin connection keeps host/port/credentials from the VALIDATED url
    // and only swaps the pathname to the maintenance database.
    const admin = new URL(clientConfig().connectionString);
    expect(admin.protocol).toBe("postgresql:");
    expect(admin.hostname).toBe("127.0.0.1");
    expect(admin.port).toBe("55432");
    expect(admin.pathname).toBe("/postgres");
    expect(admin.search).toBe("");
    expect(admin.username).toBe("synthetic_user");

    // The existence probe is parameterized with the validated database NAME.
    const instance = clientInstance();
    expect(instance.connect).toHaveBeenCalledTimes(1);
    expect(instance.query).toHaveBeenCalledTimes(1);
    expect(instance.query.mock.calls[0][1]).toEqual(["jiangtang_qa_test"]);
    expect(instance.query.mock.calls[0][0]).toContain("pg_database");
    expect(instance.end).toHaveBeenCalledTimes(1);
  });

  it("provisionTestDatabase passes the validated URL to BOTH subprocess calls", () => {
    const validated = testDatabaseUrl();
    provisionTestDatabase(validated);

    expect(h.execFileSync).toHaveBeenCalledTimes(2);
    const commands = h.execFileSync.mock.calls.map((c) => c[0] as string);
    expect(commands).toContain("pnpm db:deploy");
    expect(commands).toContain("pnpm db:seed");

    for (const call of h.execFileSync.mock.calls) {
      const opts = call[1] as { env: Record<string, string | undefined> };
      expect(opts.env.DATABASE_URL).toBe(validated);
    }
  });

  it("global setup provides the validated URL once and hands the SAME value to both provisioning calls", async () => {
    const provide = vi.fn();
    await globalSetup({ provide } as unknown as TestProject);

    expect(provide).toHaveBeenCalledTimes(1);
    expect(provide).toHaveBeenCalledWith("testDatabaseUrl", SYNTH_TEST);
    const provided = provide.mock.calls[0][1] as string;

    // No double `_test_test` suffix.
    expect(provided).toMatch(/_test$/);
    expect(provided).not.toMatch(/_test_test$/);

    // ensureTestDatabase received the provided value.
    expect(h.Client).toHaveBeenCalledTimes(1);
    const admin = new URL(clientConfig().connectionString);
    expect(`${admin.hostname}:${admin.port}`).toBe("127.0.0.1:55432");
    expect(clientInstance().query.mock.calls[0][1]).toEqual([
      new URL(provided).pathname.replace(/^\//, ""),
    ]);

    // provisionTestDatabase received the provided value on both calls.
    expect(h.execFileSync).toHaveBeenCalledTimes(2);
    for (const call of h.execFileSync.mock.calls) {
      const opts = call[1] as { env: Record<string, string | undefined> };
      expect(opts.env.DATABASE_URL).toBe(provided);
    }
  });

  it("global setup leaves the original DATABASE_URL unchanged", async () => {
    const provide = vi.fn();
    await globalSetup({ provide } as unknown as TestProject);
    expect(process.env.DATABASE_URL).toBe(SYNTH_BASE);
    expect(process.env.DATABASE_URL_TEST).toBe(SYNTH_TEST);
  });

  it("global setup derives the _test sibling when DATABASE_URL_TEST is absent", async () => {
    vi.stubEnv("DATABASE_URL_TEST", "");
    const provide = vi.fn();
    await globalSetup({ provide } as unknown as TestProject);
    expect(provide).toHaveBeenCalledWith(
      "testDatabaseUrl",
      "postgresql://synthetic_user:synthetic_pass@127.0.0.1:55432/jiangtang_qa_test",
    );
    expect(h.Client).toHaveBeenCalledTimes(1);
    expect(h.execFileSync).toHaveBeenCalledTimes(2);
  });

  const INVALID: Array<{
    label: string;
    base: string;
    test: string;
    message: string | RegExp;
  }> = [
    {
      label: "non-postgres protocol",
      base: "mysql://127.0.0.1:55432/jiangtang_qa",
      test: "",
      message: "must use postgresql:// or postgres://",
    },
    {
      label: "override without _test",
      base: SYNTH_BASE,
      test: "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_prod",
      message: "must end with _test",
    },
    {
      label: "query routing override",
      base: SYNTH_BASE,
      test: "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?hostaddr=1.2.3.4",
      message: "routing override",
    },
    {
      label: "unknown query key",
      base: SYNTH_BASE,
      test: "postgresql://synthetic_user@127.0.0.1:55432/jiangtang_qa_test?load_balance_hosts=primary",
      message: "Query parameter load_balance_hosts is not allowed",
    },
    {
      label: "encoded hostname",
      base: "postgresql://%6cocalhost:55432/jiangtang_qa",
      test: "",
      message: "Encoded hostnames are not allowed",
    },
    {
      label: "same identity as source",
      base: SYNTH_TEST,
      test: "postgresql://other_user:other_pass@127.0.0.1:55432/jiangtang_qa_test",
      message: "must not be the same database",
    },
    {
      label: "missing base",
      base: "",
      test: "",
      message: "DATABASE_URL must be set",
    },
  ];

  for (const c of INVALID) {
    it(`invalid input (${c.label}) calls NEITHER provisioning function and provides nothing`, async () => {
      clearProvisioningSpies();
      vi.stubEnv("DATABASE_URL", c.base);
      vi.stubEnv("DATABASE_URL_TEST", c.test);

      const provide = vi.fn();
      await expect(globalSetup({ provide } as unknown as TestProject), c.label).rejects.toThrow(
        c.message,
      );

      expect(provide, `${c.label}: nothing may be provided`).not.toHaveBeenCalled();
      expect(h.Client, `${c.label}: ensureTestDatabase must not run`).not.toHaveBeenCalled();
      expect(
        h.execFileSync,
        `${c.label}: provisionTestDatabase must not run`,
      ).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// The global setup uses Vitest 3's `project.provide("testDatabaseUrl", url)`
// and the worker uses `inject("testDatabaseUrl")`. These cases drive
// the real producer (`test/global-setup.ts`) and the real consumer
// (`test/setup-env.ts`) and compare the two values.
// ---------------------------------------------------------------------------
describe("provide/inject round trip", () => {
  beforeEach(() => {
    clearProvisioningSpies();
    vi.stubEnv("DATABASE_URL", SYNTH_BASE);
    vi.stubEnv("DATABASE_URL_TEST", SYNTH_TEST);
  });

  it("worker setup injects exactly the value global setup provided", async () => {
    const provide = vi.fn();
    await globalSetup({ provide } as unknown as TestProject);
    const provided = provide.mock.calls[0][1] as string;
    expect(typeof provided).toBe("string");

    const injectSpy = vi.fn(() => provided);
    const savedWorkerUrl = process.env.DATABASE_URL;

    vi.resetModules();
    vi.doMock("vitest", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, inject: injectSpy };
    });

    try {
      await import("./setup-env");
      expect(injectSpy).toHaveBeenCalledTimes(1);
      expect(injectSpy).toHaveBeenCalledWith("testDatabaseUrl");
      // The worker's DATABASE_URL is the PROVIDED value, verbatim — no
      // re-derivation and no second `_test` suffix.
      expect(process.env.DATABASE_URL).toBe(provided);
      expect(process.env.DATABASE_URL).toBe(SYNTH_TEST);
      expect(process.env.DATABASE_URL).not.toMatch(/_test_test/);
    } finally {
      vi.doUnmock("vitest");
      vi.resetModules();
      process.env.DATABASE_URL = savedWorkerUrl;
    }
  });

  it("worker setup fails closed when nothing was provided", async () => {
    const injectSpy = vi.fn(() => undefined);
    const savedWorkerUrl = process.env.DATABASE_URL;

    vi.resetModules();
    vi.doMock("vitest", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, inject: injectSpy };
    });

    try {
      await expect(import("./setup-env")).rejects.toThrow(
        "testDatabaseUrl not provided by global-setup",
      );
      expect(injectSpy).toHaveBeenCalledWith("testDatabaseUrl");
      // Fail closed: the worker must NOT have been left pointing at the source
      // database by a partial assignment.
      expect(process.env.DATABASE_URL).toBe(savedWorkerUrl);
    } finally {
      vi.doUnmock("vitest");
      vi.resetModules();
      process.env.DATABASE_URL = savedWorkerUrl;
    }
  });

  it("the provided context key is the declared ProvidedContext key", async () => {
    // Guards against a silent rename on either side of the round trip.
    const provide = vi.fn();
    await globalSetup({ provide } as unknown as TestProject);
    expect(provide.mock.calls[0][0]).toBe("testDatabaseUrl");
  });
});
