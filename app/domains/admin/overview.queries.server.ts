import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { db } from "~/lib/db.server";
import { getAi } from "~/lib/ai/registry.server";
import { getCalDavConfig } from "~/lib/calendar/caldav.server";
import { calendarSyncHealth } from "~/lib/calendar/outbox.server";
import { getIndexStats } from "~/lib/search/indexer.server";
import { buildInfo } from "~/lib/version.server";
import { storageRoot } from "~/lib/storage/config.server";
import { environmentStatus } from "~/lib/environment.server";
import type { MessageKey } from "~/i18n";
import { encryptBuffer } from "~/lib/storage/crypto.server";

export async function migrationsBehind(directory = resolve("prisma/migrations")) {
  const [files, rows] = await Promise.all([
    readdir(directory, { withFileTypes: true }),
    db.$queryRaw<
      { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
    >`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`,
  ]);
  const applied = new Set(rows.filter((r) => r.finished_at).map((r) => r.migration_name));
  return (
    rows.some((r) => !r.finished_at && !r.rolled_back_at) ||
    files.some((f) => f.isDirectory() && !applied.has(f.name))
  );
}

export async function storageWritable(root = storageRoot()) {
  const path = join(root, `.health-${randomUUID()}`);
  try {
    const probe = encryptBuffer(Buffer.alloc(0));
    await mkdir(root, { recursive: true });
    const file = await open(path, "wx");
    try {
      await file.writeFile(probe);
    } finally {
      await file.close();
      await unlink(path);
    }
    return true;
  } catch {
    return false;
  }
}

type Check = {
  id: string;
  href: string;
  label: MessageKey;
  message: MessageKey;
  severity: "fault" | "warning";
  run: () => Promise<boolean>;
};

export const overviewChecks: Check[] = [
  {
    id: "migrations",
    href: "/admin/about",
    label: "admin.overview.check.migrations",
    message: "admin.overview.problem.migrations",
    severity: "fault",
    run: () => migrationsBehind(),
  },
  {
    id: "storage",
    href: "/admin/about",
    label: "admin.overview.check.storage",
    message: "admin.overview.problem.storage",
    severity: "fault",
    run: async () => !(await storageWritable()),
  },
  {
    id: "calendar",
    href: "/admin/search-index",
    label: "admin.overview.check.calendar",
    message: "admin.overview.problem.calendar",
    severity: "fault",
    run: async () => {
      if (!getCalDavConfig()) return false;
      const [health, overdue] = await Promise.all([
        calendarSyncHealth(),
        db.calendarOutbox.count({
          where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - 15 * 60_000) } },
        }),
      ]);
      return health.failed + health.retrying + overdue > 0;
    },
  },
  {
    id: "search",
    href: "/admin/search-index",
    label: "admin.overview.check.search",
    message: "admin.overview.problem.search",
    severity: "warning",
    run: async () => {
      const stats = await getIndexStats();
      return stats.failedJobs + stats.pendingJobs > 0 || stats.overdueEmbeddings > 0;
    },
  },
  {
    id: "adminTwoFactor",
    href: "/admin/users",
    label: "admin.overview.check.adminTwoFactor",
    message: "admin.overview.problem.adminTwoFactor",
    severity: "warning",
    run: async () =>
      (await db.user.count({ where: { role: "ADMIN", isActive: true, twoFactorEnabled: false } })) >
      0,
  },
  {
    id: "bootstrap",
    href: "/admin/about",
    label: "admin.overview.check.bootstrap",
    message: "admin.overview.problem.bootstrap",
    severity: "warning",
    run: async () =>
      environmentStatus().some((variable) => variable.expectedUnset && variable.set) &&
      (await db.user.count({ where: { role: "ADMIN", isActive: true } })) > 0,
  },
];

async function limited<T>(run: () => Promise<T>, timeoutMs = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runOverviewChecks(checks = overviewChecks, timeoutMs = 1500) {
  return (
    await Promise.all(
      checks.map(async (check) => {
        const { run, ...detail } = check;
        try {
          return (await limited(run, timeoutMs)) ? { ...detail, unavailable: false } : null;
        } catch {
          return { ...detail, unavailable: true, severity: "warning" as const };
        }
      }),
    )
  ).filter((p) => p !== null);
}

export async function getAdminOverview() {
  const [problems, setup] = await Promise.all([
    runOverviewChecks(),
    limited(async () => {
      const [pending, teammates] = await Promise.all([
        db.invitation.count({
          where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
        db.user.count({ where: { isActive: true } }),
      ]);
      return { pending, team: pending > 0 || teammates > 1 };
    }).catch(() => null),
  ]);
  if (!setup)
    problems.push({
      id: "setup",
      href: "/admin/invitations",
      label: "admin.overview.check.setup",
      message: "admin.overview.check.setup",
      severity: "warning",
      unavailable: true,
    });
  return {
    build: buildInfo,
    problems,
    pendingInvitations: setup?.pending ?? null,
    steps:
      setup && !setup.team
        ? [
            {
              key: "admin.overview.step.team" as const,
              href: "/admin/users/new",
              done: false,
              optional: false,
            },
            {
              key: "admin.overview.step.calendar" as const,
              href: "/admin/search-index",
              done: !!getCalDavConfig(),
              optional: true,
            },
            {
              key: "admin.overview.step.embedding" as const,
              href: "/admin/search-index",
              done: !!getAi().embedding,
              optional: true,
            },
          ].filter((step) => !step.done)
        : [],
  };
}
