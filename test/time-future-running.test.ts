import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import {
  createTimeEntry,
  deleteTimeEntry,
  startTimer,
  stopTimer,
  updateTimeEntry,
} from "~/domains/time/time.mutations.server";
import type { TimeEntryInput } from "~/domains/time/time.schema";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";

const prefix = `p3-time-${crypto.randomUUID()}`;
const now = new Date("2026-11-09T12:00:00.000Z");
const past = new Date(now.getTime() - 3_600_000);
const future = new Date(now.getTime() + 1);
const members = ["owner", "other", "admin"].map((name) => ({
  id: `${prefix}-${name}`,
  name: `Synthetic ${name}`,
  role: name === "admin" ? ("ADMIN" as const) : ("MEMBER" as const),
}));
const [owner, other, admin] = members;
let taskId: string;

beforeAll(async () => {
  await db.user.createMany({
    data: members.map((user) => ({ ...user, email: `${user.id}@example.test` })),
  });
  await db.userPermission.create({ data: { userId: admin.id, permission: "time.editOthers" } });
  taskId = (await db.task.create({ data: { title: `${prefix} task` } })).id;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(async () => {
  vi.useRealTimers();
  await db.timeEntry.deleteMany({ where: { userId: { in: members.map((user) => user.id) } } });
});

afterAll(async () => {
  await db.task.delete({ where: { id: taskId } });
  await db.user.deleteMany({ where: { id: { in: members.map((user) => user.id) } } });
  await db.$disconnect();
});

const running = (overrides: Partial<TimeEntryInput> = {}): TimeEntryInput => ({
  startsAt: past,
  endsAt: null,
  comment: null,
  ...overrides,
});

const audits = (entityId: string) => db.activityLog.findMany({ where: { entityId } });
const snapshot = async () => ({
  entries: await db.timeEntry.findMany({
    where: { userId: { in: members.map((user) => user.id) } },
    orderBy: { id: "asc" },
  }),
  audits: await db.activityLog.findMany({
    where: { actorId: { in: members.map((user) => user.id) } },
    orderBy: { id: "asc" },
  }),
});

async function legacy(startsAt = future) {
  return db.timeEntry.create({ data: { userId: owner.id, startsAt } });
}

async function expectRefusal(call: () => Promise<unknown>, message: string) {
  const before = await snapshot();
  const error = await call().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ fieldErrors: { startsAt: [message] }, formErrors: [message] });
  const response = toErrorResponse(error);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: "ValidationError",
    fieldErrors: { startsAt: [message] },
    formErrors: [message],
  });
  expect(await snapshot()).toEqual(before);
}

describe("future running time entry policy", () => {
  it.each([0, -1, -3_600_000])("accepts creation at now %+dms", async (offset) => {
    const startsAt = new Date(now.getTime() + offset);
    const entry = await createTimeEntry(owner, running({ startsAt }));
    expect(entry.startsAt).toEqual(startsAt);
    expect(entry.endsAt).toBeNull();
    expect((await audits(entry.id)).map((log) => log.action)).toEqual(["TimeEntryCreated"]);
  });

  it.each([0, -1, -3_600_000])("accepts editing to running at now %+dms", async (offset) => {
    const entry = await createTimeEntry(owner, running({ endsAt: now }));
    const startsAt = new Date(now.getTime() + offset);
    expect(await updateTimeEntry(owner, entry.id, running({ startsAt }))).toMatchObject({
      startsAt,
      endsAt: null,
    });
    expect((await audits(entry.id)).map((log) => log.action).sort()).toEqual([
      "TimeEntryCreated",
      "TimeEntryUpdated",
    ]);
  });

  it.each([
    ["member", owner, undefined],
    ["member cannot select another owner", owner, other.id],
    ["admin self", admin, undefined],
    ["admin for another user", admin, other.id],
  ] as const)("rejects future +1ms creation: %s", async (_label, actor, userId) => {
    if (actor === owner && userId === other.id) {
      await expect(
        createTimeEntry(actor, running({ startsAt: future, userId })),
      ).rejects.toMatchObject({ status: 403 });
      return;
    }
    await expectRefusal(
      () => createTimeEntry(actor, running({ startsAt: future, userId })),
      t("de", "work.err.time.futureRunning"),
    );
  });

  for (const actor of [owner, admin]) {
    it(`rejects ${actor.role} edits from finished or running to future running`, async () => {
      const entry = await createTimeEntry(owner, running({ endsAt: now }));
      await expectRefusal(
        () => updateTimeEntry(actor, entry.id, running({ startsAt: future })),
        t("de", "work.err.time.futureRunning"),
      );
      await updateTimeEntry(owner, entry.id, running());
      await expectRefusal(
        () => updateTimeEntry(actor, entry.id, running({ startsAt: future })),
        t("de", "work.err.time.futureRunning"),
      );
    });
  }

  it.each(["comment", "taskId", "startsAt"] as const)(
    "rejects a legacy future running row with changed %s, but preserves identical no-ops",
    async (field) => {
      const entry = await legacy();
      const before = await snapshot();
      expect(await updateTimeEntry(owner, entry.id, running({ startsAt: future }))).toEqual(entry);
      expect(await snapshot()).toEqual(before);
      const change = {
        comment: { comment: "Changed" },
        taskId: { taskId },
        startsAt: { startsAt: new Date(future.getTime() + 1) },
      }[field];
      await expectRefusal(
        () => updateTimeEntry(owner, entry.id, running({ startsAt: future, ...change })),
        t("de", "work.err.time.futureRunning"),
      );
    },
  );

  it.each([
    ["historical", past, now],
    ["future", future, new Date(future.getTime() + 60_000)],
  ] as const)("keeps accepted %s finished intervals", async (_label, startsAt, endsAt) => {
    const input = running({ startsAt, endsAt });
    const created = await createTimeEntry(owner, input);
    expect(created).toMatchObject({ startsAt, endsAt });
    const updated = await updateTimeEntry(owner, created.id, { ...input, comment: "Edit" });
    expect(updated).toMatchObject({ startsAt, endsAt, comment: "Edit" });
    const before = await snapshot();
    expect(await updateTimeEntry(owner, created.id, { ...input, comment: "Edit" })).toEqual(
      updated,
    );
    expect(await snapshot()).toEqual(before);
    await deleteTimeEntry(owner, created.id);
    expect((await audits(created.id)).map((log) => log.action).sort()).toEqual([
      "TimeEntryCreated",
      "TimeEntryDeleted",
      "TimeEntryUpdated",
    ]);
  });

  it("preserves missing-entry, ownership, task and target-user validation precedence", async () => {
    const entry = await legacy();
    const input = running({ startsAt: future, taskId: "missing-task" });
    const before = await snapshot();
    await expect(updateTimeEntry(other, "missing-entry", input)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(updateTimeEntry(other, entry.id, input)).rejects.toMatchObject({
      status: 403,
    });
    await expect(updateTimeEntry(admin, entry.id, input)).rejects.toMatchObject({
      fieldErrors: { taskId: [t("de", "work.err.task.unknown")] },
    });
    await expect(createTimeEntry(owner, input)).rejects.toMatchObject({
      fieldErrors: { taskId: [t("de", "work.err.task.unknown")] },
    });
    await expect(
      createTimeEntry(admin, running({ startsAt: future, userId: "missing-user" })),
    ).rejects.toMatchObject({ fieldErrors: { userId: [t("de", "work.err.time.unknownUser")] } });
    expect(await snapshot()).toEqual(before);
  });

  it("retains ownership selection and does not reassign an entry on edit", async () => {
    await expect(
      createTimeEntry(owner, running({ endsAt: now, userId: other.id })),
    ).rejects.toMatchObject({ status: 403 });
    const own = await createTimeEntry(owner, running({ endsAt: now }));
    expect(own.userId).toBe(owner.id);
    const filed = await createTimeEntry(admin, running({ userId: other.id }));
    expect(filed.userId).toBe(other.id);
    const edited = await updateTimeEntry(
      admin,
      filed.id,
      running({ comment: "Edit", userId: owner.id }),
    );
    expect(edited.userId).toBe(other.id);
  });

  it("keeps startTimer at the sampled now and the existing unique constraint", async () => {
    const entry = await startTimer(owner, taskId);
    expect(entry.startsAt).toEqual(now);
    await expect(startTimer(owner)).rejects.toMatchObject({
      formErrors: [t("de", "work.err.time.timerAlreadyRunning")],
    });
    await expect(createTimeEntry(owner, running())).rejects.toMatchObject({
      formErrors: [t("de", "work.err.time.timerAlreadyRunning")],
    });
    expect((await audits(entry.id)).map((log) => log.action)).toEqual(["TimeEntryStarted"]);
  });

  it.each(["en", "de"] as const)(
    "gives a recoverable legacy Stop error in %s without writes",
    async (locale) => {
      await legacy();
      await runWithLocale(locale, () =>
        expectRefusal(() => stopTimer(owner), t(locale, "work.err.time.futureTimerStop")),
      );
    },
  );

  it("recovers a legacy future timer by correcting its start then stopping", async () => {
    const entry = await legacy();
    await updateTimeEntry(owner, entry.id, running());
    expect(await stopTimer(owner)).toMatchObject({ startsAt: past, endsAt: now });
    expect((await audits(entry.id)).map((log) => log.action).sort()).toEqual([
      "TimeEntryStopped",
      "TimeEntryUpdated",
    ]);
    const before = await snapshot();
    await expect(stopTimer(owner)).rejects.toMatchObject({
      formErrors: [t("de", "work.err.time.noTimerRunning")],
    });
    expect(await snapshot()).toEqual(before);
  });

  describe.each(["en", "de"] as const)("%s exact-now Stop boundary", (locale) => {
    it.each(["create", "start"] as const)(
      "%s allows a running start at now, refuses an equal Stop without writes, and stops at +1ms",
      async (via) => {
        const entry =
          via === "create"
            ? await createTimeEntry(owner, running({ startsAt: now }))
            : await startTimer(owner);
        expect(entry.startsAt).toEqual(now);
        const before = await snapshot();
        await runWithLocale(locale, async () => {
          const error = await stopTimer(owner).catch((error: unknown) => error);
          expect(await snapshot()).toEqual(before);
          const response = toErrorResponse(error);
          expect(response.status).toBe(422);
          expect(await response.json()).toMatchObject({
            fieldErrors: { startsAt: [t(locale, "work.err.time.futureTimerStop")] },
            formErrors: [t(locale, "work.err.time.futureTimerStop")],
          });
        });
        const endsAt = new Date(now.getTime() + 1);
        vi.setSystemTime(endsAt);
        expect(await stopTimer(owner)).toMatchObject({ id: entry.id, startsAt: now, endsAt });
        const logs = await audits(entry.id);
        expect(logs).toHaveLength(2);
        expect(logs.find((log) => log.action === "TimeEntryStopped")?.data).toMatchObject({
          minutes: 0,
        });
      },
    );
  });

  it("lets the owner/admin finish a legacy future entry without rewriting its start", async () => {
    const entry = await legacy();
    const endsAt = new Date(future.getTime() + 60_000);
    expect(
      await updateTimeEntry(admin, entry.id, running({ startsAt: future, endsAt })),
    ).toMatchObject({ startsAt: future, endsAt });
  });

  it("does not let admins Stop another user's timer or anonymous actors start/stop", async () => {
    await legacy();
    const before = await snapshot();
    await expect(stopTimer(admin)).rejects.toMatchObject({
      formErrors: [t("de", "work.err.time.noTimerRunning")],
    });
    for (const mutation of [startTimer, stopTimer]) {
      await expect(mutation({})).rejects.toMatchObject({
        formErrors: [t("de", "work.err.time.timerRequired")],
      });
    }
    await expect(createTimeEntry({}, running({ startsAt: future }))).rejects.toMatchObject({
      formErrors: [t("de", "work.err.time.entryAuthorRequired")],
    });
    expect(await snapshot()).toEqual(before);
  });
});

async function hold(id: string) {
  let locked!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = txWithAudit(owner, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "TimeEntry" WHERE "id" = ${id} FOR UPDATE`;
    locked();
    await unlock;
  });
  await ready;
  return { release, blocker };
}

async function waitForLocks(count: number) {
  await expect
    .poll(
      async () => {
        const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE '%"TimeEntry"%'
    `;
        return Number(row.count);
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(count);
}

describe("Stop guards the locked current row", () => {
  it.each(["future-finished", "corrected-running"] as const)(
    "does not use a stale pre-edit interval after a competing %s edit",
    async (kind) => {
      const entry = await createTimeEntry(owner, running());
      const lock = await hold(entry.id);
      const futureFinishedStart = new Date(now.getTime() + 3_600_000);
      const input =
        kind === "future-finished"
          ? running({
              startsAt: futureFinishedStart,
              endsAt: new Date(futureFinishedStart.getTime() + 60_000),
            })
          : running({ startsAt: new Date(past.getTime() + 60_000) });
      let edited!: Promise<PromiseSettledResult<unknown>[]>;
      let stopped!: Promise<PromiseSettledResult<unknown>[]>;
      try {
        edited = Promise.allSettled([updateTimeEntry(owner, entry.id, input)]);
        await waitForLocks(1);
        stopped = Promise.allSettled([stopTimer(owner)]);
        await waitForLocks(2);
        vi.setSystemTime(now);
      } finally {
        lock.release();
        await lock.blocker;
      }
      expect((await edited)[0].status).toBe("fulfilled");
      const result = (await stopped)[0];
      if (kind === "future-finished") {
        expect(result).toMatchObject({
          status: "rejected",
          reason: {
            formErrors: [t("de", "work.err.time.noTimerRunning")],
          },
        });
        expect(await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject(
          input,
        );
        expect((await audits(entry.id)).map((log) => log.action).sort()).toEqual([
          "TimeEntryCreated",
          "TimeEntryUpdated",
        ]);
      } else {
        expect(result).toMatchObject({
          status: "fulfilled",
          value: { startsAt: input.startsAt, endsAt: now },
        });
        const log = (await audits(entry.id)).find((log) => log.action === "TimeEntryStopped");
        expect(log?.data).toMatchObject({ minutes: 59 });
      }
    },
  );

  it("samples the stop clock after acquiring the row lock", async () => {
    const entry = await legacy();
    const lock = await hold(entry.id);
    const stopped = Promise.allSettled([stopTimer(owner)]);
    try {
      await waitForLocks(1);
      vi.setSystemTime(new Date(future.getTime() + 1));
    } finally {
      lock.release();
      await lock.blocker;
    }
    expect((await stopped)[0]).toMatchObject({
      status: "fulfilled",
      value: { startsAt: future, endsAt: new Date(future.getTime() + 1) },
    });
  });

  it("does not stop or audit the same locked running row twice", async () => {
    const entry = await createTimeEntry(owner, running());
    const lock = await hold(entry.id);
    const stopped = Promise.allSettled([stopTimer(owner), stopTimer(owner)]);
    try {
      await waitForLocks(2);
    } finally {
      lock.release();
      await lock.blocker;
    }
    const results = await stopped;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { formErrors: [t("de", "work.err.time.noTimerRunning")] },
    });
    expect((await audits(entry.id)).map((log) => log.action).sort()).toEqual([
      "TimeEntryCreated",
      "TimeEntryStopped",
    ]);
  });
});
