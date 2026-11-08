import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "~/lib/auth.server";

const TEST_USER: AuthUser = {
  id: "export-route-test",
  name: "Export Route Tester",
  email: "export-route@test.local",
  initials: "ER",
  role: "ADMIN",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return {
    ...actual,
    requireUser: vi.fn(async () => TEST_USER),
    // Faithful stand-in for the real check: a MEMBER gets the same 403 Response.
    requireRole: vi.fn(async (_req: Request, role: string) => {
      if (role === "ADMIN" && TEST_USER.role !== "ADMIN") {
        throw new Response("Forbidden", { status: 403 });
      }
      return TEST_USER;
    }),
  };
});

const exportRoute = await import("~/routes/export.workspace[.]json/route");
const { workspaceTransferSchema, TRANSFER_FORMAT } =
  await import("~/domains/transfer/transfer.schema");

const download = () =>
  exportRoute.loader({
    request: new Request("http://localhost/export/workspace.json"),
  } as never);

describe("GET /export/workspace.json", () => {
  it("refuses a MEMBER: the whole workspace is an admin download", async () => {
    TEST_USER.role = "MEMBER";
    await expect(download()).rejects.toMatchObject({ status: 403 });
  });

  it("an ADMIN downloads the versioned jiangtang-workspace document with a dated filename", async () => {
    TEST_USER.role = "ADMIN";
    const res = await download();

    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="jiangtang-workspace-\d{4}-\d{2}-\d{2}\.json"$/,
    );

    const body = JSON.parse(await res.text());
    expect(TRANSFER_FORMAT).toBe("jiangtang-workspace");
    expect(body.format).toBe("jiangtang-workspace");
    expect(body.version).toBe(1);
    // The downloaded document is exactly what the import schema accepts.
    expect(workspaceTransferSchema.safeParse(body).success).toBe(true);
  });
});
