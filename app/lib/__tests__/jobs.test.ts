import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { txWithAudit } from "~/lib/audit.server";
import { enqueueJob, getJobQueue } from "~/lib/jobs.server";
import { register } from "~/lib/jobs.boot.server";
import { register as registerLifecycle } from "~/lib/lifecycle-retention.boot.server";
import type { BootContext } from "~/server/boot";

const testQueue = `job-test-${randomUUID()}`;
let jobs: PgBoss;
let shutdown: () => Promise<void> | void;

beforeAll(async () => {
  const app = {} as Express;
  const ctx: BootContext = {
    env: "production",
    server: {} as BootContext["server"],
    onShutdown: (hook) => {
      shutdown = hook;
    },
  };
  await register(app, ctx);
  jobs = getJobQueue()!;
  expect(jobs).toBeDefined();
  await registerLifecycle(app, ctx);
  await jobs.createQueue(testQueue, { retryLimit: 1, retryDelay: 2, retryBackoff: true });
});

afterAll(async () => {
  if (!shutdown) return;
  try {
    await jobs.deleteQueue(testQueue);
  } finally {
    await shutdown();
    await shutdown();
    expect(getJobQueue()).toBeUndefined();
  }
});

it("schedules the lifecycle sweep and persists a boot run and its result", async () => {
  expect(await jobs.getSchedules("lifecycle-retention")).toMatchObject([
    { name: "lifecycle-retention", cron: "0 3 * * *", timezone: "UTC" },
  ]);
  await vi.waitFor(
    async () => {
      const records = await jobs.findJobs("lifecycle-retention");
      expect(records).toContainEqual(
        expect.objectContaining({
          state: "completed",
          output: {
            sessions: expect.any(Number),
            verifications: expect.any(Number),
            outbox: expect.any(Number),
            notifications: expect.any(Number),
          },
        }),
      );
    },
    { timeout: 15_000 },
  );
});

it("enqueues on the audited transaction and preserves scheduled time only on commit", async () => {
  const startAfter = new Date("2099-11-18T00:00:00Z");
  const committed = await txWithAudit(null, (tx) =>
    enqueueJob(tx, testQueue, { signal: "committed" }, startAfter),
  );
  let rolledBack: string | null = null;
  await expect(
    txWithAudit(null, async (tx) => {
      rolledBack = await enqueueJob(tx, testQueue, { signal: "rolled back" }, startAfter);
      throw new Error("Rollback");
    }),
  ).rejects.toThrow("Rollback");
  expect(committed).toEqual(expect.any(String));
  expect(rolledBack).toEqual(expect.any(String));
  expect(await jobs.findJobs(testQueue)).toEqual([
    expect.objectContaining({ id: committed, state: "created", startAfter }),
  ]);
  await expect(
    txWithAudit(null, (tx) => enqueueJob(tx, `${testQueue}-missing`, {})),
  ).rejects.toThrow("does not exist");
});

it("persists retry state with a backoff and completes the next attempt", async () => {
  let attempts = 0;
  await jobs.work(testQueue, { pollingIntervalSeconds: 0.5 }, async () => {
    if (++attempts === 1) throw new Error("Synthetic transient failure");
    return { ok: true };
  });
  const id = await txWithAudit(null, (tx) => enqueueJob(tx, testQueue, {}));
  expect(id).toEqual(expect.any(String));
  const job = async () => (await jobs.findJobs(testQueue, { id: id! }))[0];
  await vi.waitFor(
    async () => {
      const row = await job();
      expect(row?.state).toBe("retry");
      expect(row!.startAfter.getTime()).toBeGreaterThan(row!.startedOn!.getTime());
    },
    { timeout: 5_000 },
  );
  await vi.waitFor(
    async () => expect(await job()).toMatchObject({ state: "completed", output: { ok: true } }),
    { timeout: 10_000 },
  );
  expect(attempts).toBe(2);
});
