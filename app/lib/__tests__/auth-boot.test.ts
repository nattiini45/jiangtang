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

const { signUpEmail, findUnique, update, bootstrapFirstAdmin } = vi.hoisted(() => ({
  signUpEmail: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  bootstrapFirstAdmin: vi.fn(),
}));

vi.mock("better-auth/node", () => ({
  toNodeHandler: () => () => undefined,
}));

vi.mock("~/lib/auth.server", () => ({
  auth: { api: { signUpEmail } },
}));

vi.mock("~/lib/db.server", () => ({
  db: { user: { findUnique, update } },
}));

vi.mock("~/lib/auth-bootstrap.server", () => ({
  bootstrapFirstAdmin,
}));

import { register } from "~/lib/auth.boot.server";

const DEFAULT_PASSWORD = "jiangtang-admin";
const DEFAULT_EMAIL = "admin@jiangtang.local";
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

    const logged = await captureConsole(() => register(fakeApp(), prodContext()));

    expect(signUpEmail).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(bootstrapFirstAdmin).toHaveBeenCalledTimes(1);
    expect(logged.flat().join("\n")).not.toContain(SENTINEL_PASSWORD);
  });
});
