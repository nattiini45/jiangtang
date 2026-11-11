import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { resetAi, setAiForTests } from "~/lib/ai/registry.server";
import {
  getAdminOverview,
  migrationsBehind,
  overviewChecks,
  runOverviewChecks,
  storageWritable,
} from "../overview.queries.server";

const root = await mkdtemp(join(tmpdir(), "overview-"));
const migration = "20990101000000_overview_test";
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetAi();
  await db.$executeRaw`DELETE FROM _prisma_migrations WHERE id = 'overview-test'`;
  await db.calendarOutbox.deleteMany({ where: { eventUid: "overview-test" } });
  await db.searchIndexJob.deleteMany({ where: { sourceId: "overview-test" } });
  await db.chunk.deleteMany({ where: { sourceId: "overview-test" } });
  await rm(root, { recursive: true, force: true });
});

it("finds missing and failed migrations, but ignores rolled-back attempts", async () => {
  await mkdir(join(root, migration), { recursive: true });
  expect(await migrationsBehind()).toBe(false);
  expect(await migrationsBehind(root)).toBe(true);
  await db.$executeRaw`INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at)
    VALUES ('overview-test', 'synthetic', ${migration}, now())`;
  expect(await migrationsBehind(root)).toBe(false);
  await db.$executeRaw`UPDATE _prisma_migrations SET finished_at = NULL WHERE id = 'overview-test'`;
  expect(await migrationsBehind(root)).toBe(true);
  await db.$executeRaw`UPDATE _prisma_migrations SET rolled_back_at = now() WHERE id = 'overview-test'`;
  expect(await migrationsBehind()).toBe(false);
});

it("probes real storage without leaving a file and reports an unwritable path", async () => {
  expect(await storageWritable(root)).toBe(true);
  expect(await readdir(root)).toEqual([]);
  await writeFile(join(root, "file"), "synthetic");
  vi.stubEnv("STORAGE_DIR", join(root, "file"));
  expect(await overviewChecks[1].run()).toBe(true);
});

it("ignores unconfigured calendar output, but detects failure, retries and old pending pushes", async () => {
  vi.stubEnv("CALDAV_URL", "");
  const row = await db.calendarOutbox.create({
    data: { eventUid: "overview-test", op: "UPSERT", payload: {}, status: "FAILED" },
  });
  expect(await overviewChecks[2].run()).toBe(false);
  vi.stubEnv("CALDAV_URL", "https://calendar.example.test/");
  vi.stubEnv("CALDAV_USERNAME", "synthetic");
  vi.stubEnv("CALDAV_PASSWORD", "synthetic");
  expect(await overviewChecks[2].run()).toBe(true);
  await db.calendarOutbox.update({
    where: { id: row.id },
    data: { status: "PENDING", attempts: 1 },
  });
  expect(await overviewChecks[2].run()).toBe(false);
  for (const data of [
    { status: "PENDING" as const, attempts: 5 },
    { attempts: 0, createdAt: new Date("2000-01-01T00:00:00Z") },
  ]) {
    await db.calendarOutbox.update({ where: { id: row.id }, data });
    expect(await overviewChecks[2].run()).toBe(true);
  }
  await db.calendarOutbox.update({ where: { id: row.id }, data: { status: "SENT" } });
  expect(await overviewChecks[2].run()).toBe(false);
  await db.calendarOutbox.update({
    where: { id: row.id },
    data: { status: "PENDING", createdAt: new Date() },
  });
  expect(await overviewChecks[2].run()).toBe(false);
});

it("reuses search stats for failed and retrying jobs without requiring an AI provider", async () => {
  setAiForTests({ embedding: null });
  expect(await overviewChecks[3].run()).toBe(false);
  const row = await db.searchIndexJob.create({
    data: {
      sourceType: "note",
      sourceId: "overview-test",
      op: "index",
      nextAttemptAt: new Date("2000-01-01T00:00:00Z"),
    },
  });
  expect(await overviewChecks[3].run()).toBe(true);
  await db.searchIndexJob.update({
    where: { id: row.id },
    data: { nextAttemptAt: new Date("2099-01-01T00:00:00Z") },
  });
  expect(await overviewChecks[3].run()).toBe(true);
  await db.searchIndexJob.delete({ where: { id: row.id } });
  await db.chunk.create({
    data: {
      sourceId: "overview-test",
      sourceType: "note",
      sourceTitle: "Synthetic",
      ordinal: 0,
      headingPath: [],
      text: "Synthetic",
      tokenCount: 1,
      contentHash: "synthetic",
      sourceUpdatedAt: new Date("2000-01-01T00:00:00Z"),
    },
  });
  setAiForTests({ embedding: { id: "overview-test", dimensions: 1024, embed: vi.fn() } });
  expect(await overviewChecks[3].run()).toBe(true);
  setAiForTests({ embedding: null });
  expect(await overviewChecks[3].run()).toBe(false);
});

it("isolates exceptions and timeouts while starting every check in parallel", async () => {
  vi.useFakeTimers();
  const started: string[] = [];
  const result = runOverviewChecks(
    [
      {
        ...overviewChecks[0],
        run: async () => {
          started.push("throw");
          throw new Error("private details");
        },
      },
      {
        ...overviewChecks[1],
        run: () => {
          started.push("timeout");
          return new Promise(() => {});
        },
      },
      {
        ...overviewChecks[2],
        run: async () => {
          started.push("healthy");
          return false;
        },
      },
    ],
    10,
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(started).toEqual(["throw", "timeout", "healthy"]);
  expect((await result).map((r) => [r.id, r.unavailable])).toEqual([
    ["migrations", true],
    ["storage", true],
  ]);
  expect(JSON.stringify(await result)).not.toContain("private details");
});

it("returns the running build and only unexpired, unaccepted invitations", async () => {
  const loaded = await getAdminOverview();
  expect(loaded.build.version).toBeTruthy();
  expect(loaded.steps).toEqual([]);
  expect(loaded.pendingInvitations).toBe(
    await db.invitation.count({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  );
});
