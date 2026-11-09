import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "~/lib/auth.server";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn(),
}));

vi.mock("~/lib/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth.server")>()),
  requireUser: mocks.requireUser,
}));

vi.mock("~/domains/api-tokens/api-tokens.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/domains/api-tokens/api-tokens.server")>()),
  createPersonalAccessToken: mocks.create,
  revokePersonalAccessToken: mocks.revoke,
  listPersonalAccessTokens: mocks.list,
}));

afterEach(() => vi.unstubAllEnvs());

const { action, loader } = await import("~/routes/_desktop.account/route");

const ORIGIN = "https://workspace.example.test";
const user = {
  id: "synthetic-member",
  name: "Synthetic Member",
  email: "member@example.test",
  initials: "SM",
  role: "MEMBER",
  twoFactorEnabled: false,
  isActive: true,
} as AuthUser;

function post(intent: string, origin?: string, fields: Record<string, string> = {}) {
  const request = new Request(`${ORIGIN}/account`, {
    method: "POST",
    headers: origin === undefined ? {} : { origin },
    body: new URLSearchParams({
      intent,
      name: "Example client",
      scope: "READ_ONLY",
      id: "token-id",
      ...fields,
    }),
  });
  return action({ request, params: {}, context: {} } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(user);
  mocks.create.mockResolvedValue({ token: "synthetic-token-result", record: { id: "token-id" } });
  mocks.revoke.mockResolvedValue({ id: "token-id" });
  mocks.list.mockResolvedValue([]);
});

describe.each(["tokenCreate", "tokenRevoke"])("/account %s origin protection", (intent) => {
  it.each([undefined, "null", "https://other.example.test", "http://workspace.example.test"])(
    "rejects origin %s before either token mutation",
    async (origin) => {
      await expect(post(intent, origin)).rejects.toMatchObject({ status: 403 });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.revoke).not.toHaveBeenCalled();
    },
  );

  it("requires sign-in before performing the mutation", async () => {
    mocks.requireUser.mockRejectedValueOnce(new Response(null, { status: 302 }));
    await expect(post(intent, ORIGIN)).rejects.toMatchObject({ status: 302 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});

describe("/account token management", () => {
  it("keeps required-2FA enrollment available without exposing other accounts' tokens", async () => {
    vi.stubEnv("REQUIRE_ADMIN_TWO_FACTOR", "true");
    const admin = { ...user, role: "ADMIN", twoFactorEnabled: false };
    mocks.requireUser.mockResolvedValueOnce(admin);
    const result = await loader({
      request: new Request(`${ORIGIN}/account`),
      params: {},
      context: {},
    } as never);
    expect(mocks.list).toHaveBeenCalledWith(admin, { all: false });
    expect(result.twoFactorRequired).toBe(true);
  });
  it("creates a same-origin token and marks the one-time response non-cacheable", async () => {
    const result = await post("tokenCreate", ORIGIN);
    expect(mocks.create).toHaveBeenCalledWith(user, { name: "Example client", scope: "READ_ONLY" });
    expect(result).toMatchObject({
      data: { intent: "tokenCreate", createdToken: { id: "token-id" } },
    });
    const init = (result as { init?: ResponseInit | null }).init;
    expect(new Headers(init?.headers).get("cache-control")).toBe("private, no-store");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("revokes a same-origin token using the authenticated actor", async () => {
    expect(await post("tokenRevoke", ORIGIN)).toEqual({ intent: "tokenRevoke", changed: true });
    expect(mocks.revoke).toHaveBeenCalledWith(user, "token-id");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns token field errors without changing credentials", async () => {
    expect(await post("tokenCreate", ORIGIN, { name: "   " })).toMatchObject({
      intent: "tokenCreate",
      fieldErrors: { name: [expect.any(String)] },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns only personal token metadata to members", async () => {
    await loader({ request: new Request(`${ORIGIN}/account`), params: {}, context: {} } as never);
    expect(mocks.list).toHaveBeenCalledWith(user, { all: false });
  });

  it("requests all safe metadata for the admin disclosure", async () => {
    const admin = { ...user, role: "ADMIN" };
    mocks.requireUser.mockResolvedValueOnce(admin);
    await loader({ request: new Request(`${ORIGIN}/account`), params: {}, context: {} } as never);
    expect(mocks.list).toHaveBeenCalledWith(admin, { all: true });
  });
});
