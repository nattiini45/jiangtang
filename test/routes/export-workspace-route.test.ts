import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "~/lib/auth.server";

const TEST_USER: AuthUser = {
  id: "export-route-test",
  name: "Export Route Tester",
  email: "export-route@test.local",
  initials: "ER",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

const exportRoute = await import("~/routes/export.workspace[.]json/route");
const { workspaceTransferSchema, TRANSFER_FORMAT } =
  await import("~/domains/transfer/transfer.schema");

describe("GET /export/workspace.json", () => {
  it("downloads the versioned jiangtang-workspace document with a dated filename", async () => {
    const res = await exportRoute.loader({
      request: new Request("http://localhost/export/workspace.json"),
    } as never);

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
