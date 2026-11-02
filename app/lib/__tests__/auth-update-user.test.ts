import { afterAll, describe, expect, it } from "vitest";
import { auth } from "~/lib/auth.server";
import { db } from "~/lib/db.server";

/**
 * Initials are set by admins through the audited user-management path, which
 * validates them. The Better Auth update endpoint must not accept them, or a
 * signed-in member could bypass both the rules and the audit row.
 */

const RUN = `t_authupd_${Date.now()}`;
const EMAIL = `${RUN}@jiangtang.local`;

function cookieFromSetCookie(setCookie: string | null): string {
  // Take the first "name=value" pair of the Set-Cookie header.
  return (setCookie ?? "").split(";")[0] ?? "";
}

afterAll(async () => {
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  if (user) {
    await db.session.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
    await db.account.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

describe("Better Auth update-user path", () => {
  it("cannot set initials, and the stored value is unchanged", async () => {
    const { response, headers } = await auth.api.signUpEmail({
      body: { email: EMAIL, password: "initials-probe-pw", name: "Initials Probe" },
      returnHeaders: true,
    });
    const sessionHeaders = new Headers({
      cookie: cookieFromSetCookie(headers.get("set-cookie")),
    });
    expect(sessionHeaders.get("cookie")).toContain("session_token");

    // Positive control: the same session can update an ordinary field.
    await expect(
      auth.api.updateUser({ body: { name: "Renamed Probe" }, headers: sessionHeaders }),
    ).resolves.toMatchObject({ status: true });

    // The typed body has no initials key (input:false), so the probe is widened on
    // purpose. The endpoint must refuse it outright, not silently drop it.
    const probe: Record<string, unknown> = { initials: "ZZQ" };
    await expect(
      auth.api.updateUser({ body: probe as { name: string }, headers: sessionHeaders }),
    ).rejects.toThrow(/initials/);

    const user = await db.user.findUniqueOrThrow({ where: { id: response.user.id } });
    expect(user.name).toBe("Renamed Probe");
    expect(user.initials).toBeNull();
  });
});
