import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { loader } from "~/routes/healthz/route";

/**
 * healthz readiness probe (deferred; TOPS). Asserts the 503 branch: when
 * the DB scalar check throws, the loader must return a 503 (so Coolify / the load
 * balancer stops routing to a broken instance) — the happy path already returns
 * 200. We drive both branches by spying on the shared `db.$queryRaw`.
 *
 * No rows are created; nothing to clean up beyond restoring the spy.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const call = () => loader({ request: new Request("http://localhost/healthz") } as never);

describe("healthz loader", () => {
  it("returns 200 { status: ok, db: up } when the DB check succeeds", async () => {
    vi.spyOn(db, "$queryRaw").mockResolvedValue([{ "?column?": 1 }] as never);
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok", db: "up" });
  });

  it("returns 503 { status: degraded, db: down } when the DB check throws", async () => {
    vi.spyOn(db, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: "degraded", db: "down" });
  });

  it("in production does NOT leak the raw error message to the unauthenticated caller", async () => {
    const prev = process.env.NODE_ENV;
    // NODE_ENV is read-only-typed; assign through a cast for the duration of the test.
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      vi.spyOn(db, "$queryRaw").mockRejectedValue(new Error("postgres://secret@internal-host/db"));
      const res = await call();
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("error");
      expect(JSON.stringify(body)).not.toContain("secret");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
    }
  });
});
