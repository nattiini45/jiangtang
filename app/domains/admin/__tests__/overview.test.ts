import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { resetAi, setAiForTests } from "~/lib/ai/registry.server";
import { storageRoot } from "~/lib/storage/config.server";
import { getIndexStats } from "~/lib/search/indexer.server";
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
  vi.stubEnv("STORAGE_DIR", undefined);
  expect(storageRoot()).toBe(resolve("data/attachments"));
  expect(await storageWritable(root)).toBe(true);
  expect(await readdir(root)).toEqual([]);
  await writeFile(join(root, "file"), "synthetic");
  vi.stubEnv("STORAGE_DIR", join(root, "file"));
  expect(storageRoot()).toBe(join(root, "file"));
  expect(await overviewChecks[1].run()).toBe(true);
});

it("requires a usable encryption key for production storage", async () => {
  vi.resetModules();
  const { storageWritable: freshStorageWritable } = await import("../overview.queries.server");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("STORAGE_ENCRYPTION_KEY", "");
  expect(await freshStorageWritable(root)).toBe(false);
  vi.stubEnv("STORAGE_ENCRYPTION_KEY", "ab".repeat(32));
  expect(await freshStorageWritable(root)).toBe(true);
  expect(await readdir(root)).toEqual([]);
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
  vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
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
  setAiForTests({ embedding: { id: "overview-test", dimensions: 1024, embed: vi.fn() } });
  const baseline = (await getIndexStats()).overdueEmbeddings;
  const chunk = await db.chunk.create({
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
      updatedAt: new Date("2030-01-01T11:46:00Z"),
    },
  });
  expect((await getIndexStats()).overdueEmbeddings).toBe(baseline);
  await db.chunk.update({
    where: { id: chunk.id },
    data: { updatedAt: new Date("2030-01-01T11:44:00Z"), embeddingModel: "previous-model" },
  });
  expect((await getIndexStats()).overdueEmbeddings).toBe(baseline + 1);
  expect(await overviewChecks[3].run()).toBe(true);
  await db.chunk.update({
    where: { id: chunk.id },
    data: { embeddingModel: "overview-test", updatedAt: new Date("2000-01-01T00:00:00Z") },
  });
  expect((await getIndexStats()).overdueEmbeddings).toBe(baseline);
  setAiForTests({ embedding: null });
  expect(await overviewChecks[3].run()).toBe(false);
});

it("reports security risks only for active admins and never exposes bootstrap values", async () => {
  const admins = await db.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  });
  const ids = admins.map((admin) => admin.id);
  const twoFactor = overviewChecks.find((check) => check.id === "adminTwoFactor")!;
  const bootstrap = overviewChecks.find((check) => check.id === "bootstrap")!;
  const sentinel = "synthetic-bootstrap-value-never-serialize";
  for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_INITIALS"]) vi.stubEnv(name, "");
  try {
    await db.user.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
    const user = await db.user.create({
      data: {
        id: "overview-security-test",
        email: "overview-security@example.test",
        name: "Synthetic",
        role: "ADMIN",
        isActive: false,
      },
    });
    expect(await twoFactor.run()).toBe(false);
    vi.stubEnv("ADMIN_PASSWORD", sentinel);
    expect(await bootstrap.run()).toBe(false);
    vi.stubEnv("ADMIN_PASSWORD", "");
    await db.user.update({ where: { id: user.id }, data: { isActive: true } });
    expect(await twoFactor.run()).toBe(true);
    await db.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
    expect(await twoFactor.run()).toBe(false);
    expect(await bootstrap.run()).toBe(false);
    for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_INITIALS"]) {
      vi.stubEnv(name, sentinel);
      const problems = await runOverviewChecks([bootstrap]);
      expect(problems).toMatchObject([
        { id: "bootstrap", href: "/admin/about", severity: "warning" },
      ]);
      expect(JSON.stringify(problems)).not.toContain(sentinel);
      vi.stubEnv(name, "");
    }
    await db.user.update({
      where: { id: user.id },
      data: { role: "MEMBER", twoFactorEnabled: false },
    });
    vi.stubEnv("ADMIN_EMAIL", sentinel);
    expect(await twoFactor.run()).toBe(false);
    expect(await bootstrap.run()).toBe(false);
  } finally {
    await db.user.deleteMany({ where: { id: "overview-security-test" } });
    await db.user.updateMany({ where: { id: { in: ids } }, data: { isActive: true } });
  }
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
