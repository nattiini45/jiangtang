import { randomBytes } from "node:crypto";
import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "~/server/boot";

/**
 * The development seed must not write the bootstrap password or the admin
 * email to any log. This suite imports the REAL `register` from
 * `~/lib/auth.boot.server`; auth, db and the production bootstrap are mocked so
 * no database or Better Auth instance is touched.
 *
 * ENV HYGIENE: the test environment exports DEV_ADMIN_PASSWORD / DEV_ADMIN_EMAIL,
 * so every case constructs its environment explicitly and restores the
 * inherited values in afterEach.
 */

const { signUpEmail, findUnique, findFirst, update, bootstrapFirstAdmin } = vi.hoisted(() => ({
  signUpEmail: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  bootstrapFirstAdmin: vi.fn(),
}));

vi.mock("better-auth/node", () => ({
  toNodeHandler: () => () => undefined,
}));

vi.mock("~/lib/auth.server", () => ({
  auth: { api: { signUpEmail } },
  MIN_PASSWORD_LENGTH: 8,
}));

vi.mock("~/lib/db.server", () => ({
  db: { user: { findUnique, findFirst, update } },
}));

vi.mock("~/lib/auth-bootstrap.server", () => ({
  bootstrapFirstAdmin,
}));

import { register } from "~/lib/auth.boot.server";

const DEFAULT_PASSWORD = "jiangtang-admin";
const DEFAULT_EMAIL = "admin@jiangtang.local";
const STRONG_SECRET = "0123456789abcdef0123456789abcdef";
const SENTINEL_PASSWORD = `probe-${randomBytes(12).toString("hex")}`;
const SENTINEL_EMAIL = "seed-probe@example.test";

const INHERITED_PASSWORD = process.env.DEV_ADMIN_PASSWORD;
const INHERITED_EMAIL = process.env.DEV_ADMIN_EMAIL;

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

function devContext(): BootContext {
  return {
    env: "development",
    server: {} as BootContext["server"],
    onShutdown: () => undefined,
  };
}

function prodContext(): BootContext {
  return { ...devContext(), env: "production" };
}

function fakeApp() {
  return { all: vi.fn() } as unknown as Parameters<typeof register>[0];
}

/** Every console call made while `run` executes, rendered to one string per call. */
async function captureConsole(run: () => Promise<void>): Promise<string[][]> {
  const spies = CONSOLE_METHODS.map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
  // Read the recorded calls BEFORE restoring: mockRestore() clears mock.calls.
  try {
    await run();
    return spies.flatMap((spy) => spy.mock.calls.map((args) => [format(...args)]));
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
}

function setSignupOk() {
  signUpEmail.mockImplementation(async ({ body }: { body: { email: string } }) => ({
    user: { id: "user-1", email: body.email },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  findFirst.mockResolvedValue(null);
  update.mockResolvedValue({});
  bootstrapFirstAdmin.mockResolvedValue(undefined);
  setSignupOk();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (INHERITED_PASSWORD === undefined) delete process.env.DEV_ADMIN_PASSWORD;
  else process.env.DEV_ADMIN_PASSWORD = INHERITED_PASSWORD;
  if (INHERITED_EMAIL === undefined) delete process.env.DEV_ADMIN_EMAIL;
  else process.env.DEV_ADMIN_EMAIL = INHERITED_EMAIL;
});

describe("register — development seed log hygiene", () => {
  it("writes neither the sentinel password nor the admin email to any log", async () => {
    vi.stubEnv("DEV_ADMIN_PASSWORD", SENTINEL_PASSWORD);
    vi.stubEnv("DEV_ADMIN_EMAIL", SENTINEL_EMAIL);

    const logged = await captureConsole(() => register(fakeApp(), devContext()));
    const text = logged.flat().join("\n");

    expect(signUpEmail).toHaveBeenCalledTimes(1);
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain(SENTINEL_EMAIL);
  });

  it("writes neither the default password nor the default email to any log", async () => {
    delete process.env.DEV_ADMIN_PASSWORD;
    delete process.env.DEV_ADMIN_EMAIL;
    // Assert the process actually sees the defaults before asserting the logs.
    expect(process.env.DEV_ADMIN_PASSWORD).toBeUndefined();
    expect(process.env.DEV_ADMIN_EMAIL).toBeUndefined();

    const logged = await captureConsole(() => register(fakeApp(), devContext()));
    const text = logged.flat().join("\n");

    expect(signUpEmail).toHaveBeenCalledTimes(1);
    expect(text).not.toContain(DEFAULT_PASSWORD);
    expect(text).not.toContain(DEFAULT_EMAIL);
  });

  it("emits exactly the successful seed line and nothing else from the seed", async () => {
    vi.stubEnv("DEV_ADMIN_PASSWORD", SENTINEL_PASSWORD);
    vi.stubEnv("DEV_ADMIN_EMAIL", SENTINEL_EMAIL);

    const logCalls: unknown[][] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
    });
    try {
      await register(fakeApp(), devContext());
    } finally {
      spy.mockRestore();
    }

    expect(logCalls).toEqual([["[seed] development admin created"]]);
  });

  it("still passes the expected password to signup and creates the admin role", async () => {
    vi.stubEnv("DEV_ADMIN_PASSWORD", SENTINEL_PASSWORD);
    vi.stubEnv("DEV_ADMIN_EMAIL", SENTINEL_EMAIL);

    await captureConsole(() => register(fakeApp(), devContext()));

    expect(signUpEmail).toHaveBeenCalledWith({
      body: { email: SENTINEL_EMAIL, password: SENTINEL_PASSWORD, name: "Dev Admin" },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { role: "ADMIN", initials: "AD", emailVerified: true },
    });
  });

  it("uses the default password for signup when no override is set", async () => {
    delete process.env.DEV_ADMIN_PASSWORD;
    delete process.env.DEV_ADMIN_EMAIL;

    await captureConsole(() => register(fakeApp(), devContext()));

    expect(signUpEmail).toHaveBeenCalledWith({
      body: { email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD, name: "Dev Admin" },
    });
  });

  it("skips creation when the seed admin already exists, and logs nothing", async () => {
    vi.stubEnv("DEV_ADMIN_PASSWORD", SENTINEL_PASSWORD);
    vi.stubEnv("DEV_ADMIN_EMAIL", SENTINEL_EMAIL);
    findUnique.mockResolvedValue({ id: "existing-1" });

    const logged = await captureConsole(() => register(fakeApp(), devContext()));

    expect(signUpEmail).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("does not seed in production but still runs the production bootstrap", async () => {
    vi.stubEnv("DEV_ADMIN_PASSWORD", SENTINEL_PASSWORD);
    vi.stubEnv("BETTER_AUTH_SECRET", STRONG_SECRET);
    vi.stubEnv("ICAL_FEED_TOKEN", "");
    vi.stubEnv("ADMIN_PASSWORD", "");

    const logged = await captureConsole(() => register(fakeApp(), prodContext()));

    expect(signUpEmail).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(bootstrapFirstAdmin).toHaveBeenCalledTimes(1);
    expect(logged.flat().join("\n")).not.toContain(SENTINEL_PASSWORD);
  });

  it("refuses to boot in production with a placeholder secret, before anything else runs", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "change-me-generate-a-long-random-string");

    await expect(register(fakeApp(), prodContext())).rejects.toThrow(/BETTER_AUTH_SECRET/);
    expect(bootstrapFirstAdmin).not.toHaveBeenCalled();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("runs the first-admin bootstrap before the development seed", async () => {
    vi.stubEnv("DEV_ADMIN_PASSWORD", SENTINEL_PASSWORD);
    vi.stubEnv("DEV_ADMIN_EMAIL", SENTINEL_EMAIL);

    await captureConsole(() => register(fakeApp(), devContext()));

    expect(bootstrapFirstAdmin).toHaveBeenCalledTimes(1);
    expect(signUpEmail).toHaveBeenCalledTimes(1);
    const bootstrapOrder = bootstrapFirstAdmin.mock.invocationCallOrder[0] ?? Infinity;
    const seedOrder = signUpEmail.mock.invocationCallOrder[0] ?? -Infinity;
    expect(bootstrapOrder).toBeLessThan(seedOrder);
  });

  it("still promotes the dev admin when the bootstrap admin already holds the AD initials", async () => {
    vi.stubEnv("DEV_ADMIN_PASSWORD", SENTINEL_PASSWORD);
    vi.stubEnv("DEV_ADMIN_EMAIL", SENTINEL_EMAIL);
    // bootstrapFirstAdmin is mocked in this file, so the holder is modelled here.
    // The real bootstrap takes these initials from ADMIN_INITIALS="AD".
    vi.stubEnv("ADMIN_INITIALS", "AD");
    findFirst.mockImplementation(async ({ where }: { where: { initials: string } }) =>
      where.initials === "AD" ? { id: "bootstrap-admin" } : null,
    );

    await captureConsole(() => register(fakeApp(), devContext()));

    expect(findFirst).toHaveBeenCalledWith({
      where: { initials: "AD", id: { not: "user-1" } },
      select: { id: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { role: "ADMIN", emailVerified: true },
    });
    expect(update.mock.calls[0]?.[0].data).not.toHaveProperty("initials");
  });

  it("gives the dev admin the AD initials when no other account holds them", async () => {
    vi.stubEnv("DEV_ADMIN_PASSWORD", SENTINEL_PASSWORD);
    vi.stubEnv("DEV_ADMIN_EMAIL", SENTINEL_EMAIL);

    await captureConsole(() => register(fakeApp(), devContext()));

    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { role: "ADMIN", initials: "AD", emailVerified: true },
    });
  });

  it("refuses to boot in production with a placeholder ADMIN_PASSWORD, before the bootstrap runs", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", STRONG_SECRET);
    vi.stubEnv("ICAL_FEED_TOKEN", "");
    vi.stubEnv("ADMIN_PASSWORD", "change-me-a-strong-password");

    await expect(register(fakeApp(), prodContext())).rejects.toThrow(/ADMIN_PASSWORD/);
    expect(bootstrapFirstAdmin).not.toHaveBeenCalled();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("refuses to boot in production with an ADMIN_PASSWORD below the minimum length, before the bootstrap runs", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", STRONG_SECRET);
    vi.stubEnv("ICAL_FEED_TOKEN", "");
    vi.stubEnv("ADMIN_PASSWORD", "abcdefg");

    await expect(register(fakeApp(), prodContext())).rejects.toThrow(
      /ADMIN_PASSWORD must be at least 8 characters/,
    );
    expect(bootstrapFirstAdmin).not.toHaveBeenCalled();
    expect(signUpEmail).not.toHaveBeenCalled();
  });
});
