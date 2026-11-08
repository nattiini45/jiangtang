import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "~/lib/auth.server";

/**
 * `/welcome` is opt-in: without `LANDING_PAGE_ENABLED=1` everyone lands on `/login`, and
 * the sign-in page does not link to it.
 */
const session = vi.hoisted(() => ({ user: null as AuthUser | null }));

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, getOptionalUser: vi.fn(async () => session.user) };
});

const welcome = await import("~/routes/welcome/route");
const login = await import("~/routes/login/route");

const SIGNED_IN = {
  id: "welcome-route-test",
  name: "Welcome Tester",
  email: "welcome@test.local",
  initials: "WT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

const visit = async (loader: (args: never) => unknown, path: string) => {
  try {
    return await loader({ request: new Request(`http://localhost${path}`) } as never);
  } catch (thrown) {
    return thrown;
  }
};

const location = (value: unknown) =>
  value instanceof Response && value.status >= 300 && value.status < 400
    ? value.headers.get("Location")
    : null;

afterEach(() => {
  vi.unstubAllEnvs();
  session.user = null;
});

describe("/welcome while the landing page is off (the default)", () => {
  it.each(["", "0", "true"])(
    "sends a visitor to /login with LANDING_PAGE_ENABLED=%j",
    async (v) => {
      vi.stubEnv("LANDING_PAGE_ENABLED", v);
      expect(location(await visit(welcome.loader, "/welcome"))).toBe("/login");
    },
  );

  it("sends a signed-in user to /login too, which forwards them to /", async () => {
    session.user = SIGNED_IN;
    expect(location(await visit(welcome.loader, "/welcome"))).toBe("/login");
  });

  it("the sign-in page does not offer the landing link", async () => {
    const data = (await visit(login.loader, "/login")) as { landingPage: boolean };
    expect(data.landingPage).toBe(false);
  });
});

describe("/welcome with LANDING_PAGE_ENABLED=1", () => {
  it("renders for a signed-out visitor and the sign-in page links to it", async () => {
    vi.stubEnv("LANDING_PAGE_ENABLED", "1");
    expect(await visit(welcome.loader, "/welcome")).toEqual({});
    const data = (await visit(login.loader, "/login")) as { landingPage: boolean };
    expect(data.landingPage).toBe(true);
  });

  it("redirects a signed-in user to the dashboard", async () => {
    vi.stubEnv("LANDING_PAGE_ENABLED", "1");
    session.user = SIGNED_IN;
    expect(location(await visit(welcome.loader, "/welcome"))).toBe("/");
  });
});
