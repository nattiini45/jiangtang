import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, getOptionalUser, requireUser } from "~/lib/auth.server";
import { completeTwoFactorSignIn } from "~/domains/auth/two-factor.server";
import { acceptInvite, resolveInvite } from "~/domains/auth/users.queries.server";
import * as login from "~/routes/login/route";
import * as twoFactor from "~/routes/login_.two-factor/route";
import * as invite from "~/routes/accept-invite.$token/route";
import * as preference from "~/routes/prefs.view/route";
import { listTicketTargets } from "~/domains/tickets/tickets.queries.server";
import * as capture from "~/routes/m._index/route";

vi.mock("~/lib/auth.server", async (original) => ({
  ...(await original<typeof import("~/lib/auth.server")>()),
  auth: { api: { signInEmail: vi.fn() } },
  getOptionalUser: vi.fn(),
  requireUser: vi.fn(),
}));
vi.mock("~/domains/auth/two-factor.server", () => ({ completeTwoFactorSignIn: vi.fn() }));
vi.mock("~/domains/auth/users.queries.server", () => ({
  acceptInvite: vi.fn(),
  resolveInvite: vi.fn(),
}));
vi.mock("~/domains/tickets/tickets.queries.server", () => ({ listTicketTargets: vi.fn() }));

const phone = { "sec-ch-ua-mobile": "?1" };
function req(path: string, form?: Record<string, string>, headers: HeadersInit = phone) {
  return new Request(`http://localhost${path}`, {
    headers,
    ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
  });
}
const args = (request: Request) =>
  ({ request, params: { token: "invite-token" }, context: {} }) as never;
const destination = (response: unknown) => {
  expect(response).toBeInstanceOf(Response);
  return (response as Response).headers.get("Location");
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOptionalUser).mockResolvedValue(null);
  vi.mocked(requireUser).mockResolvedValue({ id: "member-1" } as never);
  vi.mocked(auth.api.signInEmail).mockImplementation(
    async () =>
      Response.json({}, { headers: { "Set-Cookie": "session=synthetic; HttpOnly" } }) as never,
  );
  vi.mocked(resolveInvite).mockResolvedValue({ id: "invite-1" } as never);
  vi.mocked(acceptInvite).mockResolvedValue(undefined as never);
  vi.mocked(completeTwoFactorSignIn).mockResolvedValue({
    ok: true,
    headers: new Headers({ "Set-Cookie": "session=synthetic; HttpOnly" }),
  });
});

describe("chosen-tree sign-in landing", () => {
  it.each([
    [phone, "/tasks/t-1?tab=notes", "/m/tasks/t-1"],
    [{ cookie: "view=desktop", ...phone }, "/tasks/t-1?tab=notes", "/tasks/t-1?tab=notes"],
    [
      { cookie: "view=mobile", "sec-ch-ua-mobile": "?0" },
      "/inventory/stock/s-1",
      "/m/inventory/stock/s-1",
    ],
    [phone, "/events/e-1", "/m"],
    [phone, "//outside.test", "/m"],
    [{}, "/m/tasks/t-1", "/m/tasks/t-1"],
    [{ cookie: "view=desktop" }, "/m/rooms/hall", "/rooms/hall"],
  ])("uses request preferences for loader and action", async (headers, next, expected) => {
    const loaded = await login.loader(
      args(req(`/login?next=${encodeURIComponent(next)}`, undefined, headers)),
    );
    expect(loaded.next).toBe(expected);
    const response = await login.action(
      args(
        req(
          "/login",
          { email: "member@example.test", password: "synthetic-password", next },
          headers,
        ),
      ),
    );
    expect(destination(response)).toBe(expected);
    expect((response as Response).headers.get("Set-Cookie")).toContain("session=synthetic");
  });

  it("sends an active signed-in visitor straight to the chosen tree", async () => {
    vi.mocked(getOptionalUser).mockResolvedValue({ isActive: true } as never);
    await expect(login.loader(args(req("/login?next=%2Frooms%2Fhall")))).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
    try {
      await login.loader(args(req("/login?next=%2Frooms%2Fhall")));
    } catch (response) {
      expect(destination(response)).toBe("/m/rooms/hall");
    }
  });

  it("does not bounce a deactivated account back into the app", async () => {
    vi.mocked(getOptionalUser).mockResolvedValue({ isActive: false } as never);
    expect(await login.loader(args(req("/login")))).toMatchObject({
      deactivated: true,
      next: "/m",
    });
  });

  it("keeps the chosen safe target through challenge, backup code and expiry", async () => {
    vi.mocked(auth.api.signInEmail).mockResolvedValue(
      Response.json(
        { twoFactorRedirect: true },
        { headers: { "Set-Cookie": "challenge=synthetic" } },
      ) as never,
    );
    const response = await login.action(
      args(
        req("/login", {
          email: "member@example.test",
          password: "synthetic-password",
          next: "/rooms/hall",
        }),
      ),
    );
    expect(destination(response)).toBe("/login/two-factor?next=%2Fm%2Frooms%2Fhall");
    const loaded = await twoFactor.loader(args(req(destination(response)! + "&method=backup")));
    expect(loaded).toEqual({ next: "/m/rooms/hall", backup: true });
    const body = { code: "backup-code", method: "backup", next: loaded.next };
    expect(destination(await twoFactor.action(args(req("/login/two-factor", body))))).toBe(
      "/m/rooms/hall",
    );
    expect(completeTwoFactorSignIn).toHaveBeenLastCalledWith(expect.any(Request), {
      code: "backup-code",
      method: "backup",
    });
    vi.mocked(completeTwoFactorSignIn).mockResolvedValue({ ok: false, reason: "expired" });
    await expect(twoFactor.action(args(req("/login/two-factor", body)))).rejects.toMatchObject({
      status: 302,
    });
  });

  it("re-evaluates an override changed between password and second factor", async () => {
    const response = await twoFactor.action(
      args(
        req(
          "/login/two-factor",
          { code: "123456", next: "/m/rooms/hall" },
          { cookie: "view=desktop", ...phone },
        ),
      ),
    );
    expect(destination(response)).toBe("/rooms/hall");
  });
});

describe("invitation and preference handoff", () => {
  it("keeps the existing plain sign-in URL for a default desktop invitation", async () => {
    const response = await invite.action(
      args(
        req(
          "/accept-invite/invite-token",
          {
            token: "invite-token",
            password: "synthetic-password",
            confirm: "synthetic-password",
          },
          {},
        ),
      ),
    );
    expect(destination(response)).toBe("/login");
  });

  it("carries safe context through invite acceptance to sign-in", async () => {
    const loaded = await invite.loader(
      args(req("/accept-invite/invite-token?next=%2Fsearch%3Fq%3Dhall")),
    );
    expect(loaded).toEqual({ token: "invite-token", next: "/m/search?q=hall" });
    const response = await invite.action(
      args(
        req("/accept-invite/invite-token", {
          token: loaded.token,
          next: loaded.next,
          password: "synthetic-password",
          confirm: "synthetic-password",
        }),
      ),
    );
    expect(destination(response)).toBe("/login?next=%2Fm%2Fsearch%3Fq%3Dhall");
    expect(acceptInvite).toHaveBeenCalledOnce();
  });

  it("defaults new phone invitees to mobile and sanitizes forged next", async () => {
    for (const next of ["", "https://outside.test"]) {
      const response = await invite.action(
        args(
          req("/accept-invite/invite-token", {
            token: "invite-token",
            next,
            password: "synthetic-password",
            confirm: "synthetic-password",
          }),
        ),
      );
      expect(destination(response)).toBe("/login?next=%2Fm");
    }
  });

  it("switches a detail to desktop persistently, then back to mobile", async () => {
    const desktop = await preference.action(
      args(req("/prefs/view", { view: "desktop", next: "/m/rooms/hall" })),
    );
    expect(destination(desktop)).toBe("/rooms/hall");
    expect(desktop.headers.get("Set-Cookie")).toContain("view=desktop; Path=/; Max-Age=31536000");
    const mobile = await preference.action(
      args(req("/prefs/view", { view: "mobile", next: "/rooms/hall" }, { cookie: "view=desktop" })),
    );
    expect(destination(mobile)).toBe("/m/rooms/hall");
    expect(mobile.headers.get("Set-Cookie")).toContain("view=mobile");
    expect(requireUser).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid view values without persisting anything", async () => {
    await expect(
      preference.action(args(req("/prefs/view", { view: "auto", next: "/" }))),
    ).rejects.toMatchObject({ init: { status: 400 } });
  });

  it("recovers an expired desktop switch after sign-in instead of landing on an action-only URL", async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(
      new Response(null, { status: 302, headers: { Location: "/login?next=%2Fprefs%2Fview" } }),
    );
    await expect(
      preference.action(
        args(
          req("/prefs/view", { view: "mobile", next: "/rooms/hall" }, { cookie: "view=desktop" }),
        ),
      ),
    ).rejects.toMatchObject({ status: 302 });
    const landing = await login.action(
      args(
        req(
          "/login",
          { email: "member@example.test", password: "synthetic-password", next: "/prefs/view" },
          { cookie: "view=desktop" },
        ),
      ),
    );
    expect(destination(landing)).toBe("/prefs/view");
    const recovered = await preference.loader(
      args(req("/prefs/view", undefined, { cookie: "view=desktop" })),
    );
    expect(destination(recovered)).toBe("/");
    expect(recovered.headers.has("Set-Cookie")).toBe(false);
  });
});

describe("mobile contextual capture landing", () => {
  it("uses only valid target IDs and a valid ticket type from QR queries", async () => {
    vi.mocked(listTicketTargets).mockResolvedValue({
      rooms: [{ id: "r-1", name: "Hall" }],
      equipment: [{ id: "e-1", label: "Projector" }],
      users: [],
    });
    const loaded = await capture.loader(args(req("/m?roomId=r-1&equipmentId=e-1&type=REQUEST")));
    expect(loaded.defaults).toEqual({ roomId: "r-1", equipmentId: "e-1", type: "REQUEST" });
    const invalid = await capture.loader(
      args(req("/m?roomId=missing&equipmentId=missing&type=invalid")),
    );
    expect(invalid.defaults).toEqual({ roomId: "", equipmentId: "", type: "INCIDENT" });
    expect(requireUser).toHaveBeenCalledTimes(2);
  });
});
