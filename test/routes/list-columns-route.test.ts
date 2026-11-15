import { afterEach, expect, it, vi } from "vitest";
import { auth } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { action } from "~/routes/list-columns/route";

afterEach(async () => {
  vi.restoreAllMocks();
  await db.listColumns.deleteMany();
});
const post = (origin = "https://workspace.example.test", columns = '["name","capacity"]') =>
  action({
    request: new Request("https://workspace.example.test/list-columns", {
      method: "POST",
      headers: { origin },
      body: new URLSearchParams({ scope: "ROOM", columns }),
    }),
    params: {},
    context: {},
  } as never);

it("refuses a member and a cross-origin admin request before writing", async () => {
  const member = await db.user.findFirstOrThrow({ where: { role: "MEMBER" } });
  const session = vi.spyOn(auth.api, "getSession").mockResolvedValue({ user: member } as never);
  await expect(post()).rejects.toMatchObject({ status: 403 });
  const admin = { ...member, role: "ADMIN" };
  session.mockResolvedValue({ user: admin } as never);
  await expect(post("https://other.example.test")).rejects.toMatchObject({ status: 403 });
  await expect(
    action({
      request: new Request("https://workspace.example.test/list-columns", {
        method: "POST",
        body: new URLSearchParams({ scope: "ROOM", columns: '["name"]' }),
      }),
      params: {},
      context: {},
    } as never),
  ).rejects.toMatchObject({ status: 403 });
  expect(await db.listColumns.count()).toBe(0);
  expect(await post()).toMatchObject({ saved: true });
  expect((await db.listColumns.findUniqueOrThrow({ where: { scope: "ROOM" } })).columns).toEqual([
    "name",
    "capacity",
  ]);
});

it("returns a recoverable error for malformed column input", async () => {
  const admin = { ...(await db.user.findFirstOrThrow()), role: "ADMIN" };
  vi.spyOn(auth.api, "getSession").mockResolvedValue({ user: admin } as never);
  expect(await post(undefined, "not json")).toMatchObject({ init: { status: 422 } });
  expect(await db.listColumns.count()).toBe(0);
});
