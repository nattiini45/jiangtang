import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { requireUser, type AuthUser } from "~/lib/auth.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";
import type { Locale } from "~/i18n/locales";

vi.mock("~/lib/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth.server")>()),
  requireUser: vi.fn(),
}));
vi.mock("~/lib/realtime/emit.server", () => ({ emitChange: vi.fn() }));

const desktop = await import("~/routes/_desktop.timesheet/route");
const mobile = await import("~/routes/m.timesheet._index/route");
const prefix = `p3-time-routes-${crypto.randomUUID()}`;
let actor: AuthUser;
const now = new Date("2026-11-09T12:00:00Z");
const future = new Date("2026-11-10T08:00:00Z");

beforeAll(async () => {
  actor = await db.user.create({
    data: { name: "Synthetic time route member", email: `${prefix}@example.test`, role: "MEMBER" },
  });
});

beforeEach(() => {
  vi.mocked(requireUser).mockReset().mockResolvedValue(actor);
  vi.mocked(emitChange).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(async () => {
  vi.useRealTimers();
  await db.timeEntry.deleteMany({ where: { userId: actor.id } });
});

afterAll(async () => {
  await db.user.delete({ where: { id: actor.id } });
  await db.$disconnect();
});

function action(
  route: typeof desktop | typeof mobile,
  locale: Locale,
  fields: Record<string, string>,
) {
  const path = route === desktop ? "/timesheet" : "/m/timesheet";
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { cookie: `locale=${locale}` },
    body: new URLSearchParams(fields),
  });
  return runWithLocale(locale, () => route.action({ request } as never));
}

const snapshot = async () => ({
  entries: await db.timeEntry.findMany({ where: { userId: actor.id }, orderBy: { id: "asc" } }),
  audits: await db.activityLog.findMany({ where: { actorId: actor.id }, orderBy: { id: "asc" } }),
});

const form = { date: "2026-11-10", startTime: "09:00", endTime: "", comment: "" };

describe.each(["en", "de"] as const)("%s time route errors", (locale) => {
  it("desktop add/edit refuses future running entries with useful field and form errors", async () => {
    const entry = await db.timeEntry.create({
      data: { userId: actor.id, startsAt: future, endsAt: new Date(future.getTime() + 60_000) },
    });
    const before = await snapshot();
    for (const intent of ["add", "edit"]) {
      expect(
        await action(desktop, locale, { ...form, _action: intent, id: entry.id }),
      ).toMatchObject({
        error: t(locale, "work.err.time.futureRunning"),
        fieldErrors: { startsAt: [t(locale, "work.err.time.futureRunning")] },
      });
      expect(await snapshot()).toEqual(before);
      expect(emitChange).not.toHaveBeenCalled();
    }
  });

  it.each(["desktop", "mobile"] as const)(
    "%s Stop exposes the recovery message, not the generic fallback",
    async (surface) => {
      await db.timeEntry.create({ data: { userId: actor.id, startsAt: future } });
      const before = await snapshot();
      expect(
        await action(surface === "desktop" ? desktop : mobile, locale, { _action: "stop-timer" }),
      ).toMatchObject({ error: t(locale, "work.err.time.futureTimerStop") });
      expect(await snapshot()).toEqual(before);
      expect(emitChange).not.toHaveBeenCalled();
    },
  );

  it("recovers through the existing desktop start editor and mobile Stop, emitting only after commit", async () => {
    const entry = await db.timeEntry.create({ data: { userId: actor.id, startsAt: future } });
    const committed: string[] = [];
    vi.mocked(emitChange).mockImplementation(async (event) => {
      const stored = await db.timeEntry.findUniqueOrThrow({ where: { id: event.id } });
      const audits = await db.activityLog.findMany({ where: { entityId: event.id } });
      const lastAction = stored.endsAt ? "TimeEntryStopped" : "TimeEntryUpdated";
      expect(audits.some((log) => log.action === lastAction)).toBe(true);
      committed.push(lastAction);
    });
    expect(
      await action(desktop, locale, {
        ...form,
        _action: "edit",
        id: entry.id,
        date: "2026-11-09",
        startTime: "12:00",
      }),
    ).toEqual({ ok: true });
    expect(await action(mobile, locale, { _action: "stop-timer" })).toEqual({ ok: true });
    expect(committed).toEqual(["TimeEntryUpdated", "TimeEntryStopped"]);
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({
      startsAt: new Date("2026-11-09T11:00:00Z"),
      endsAt: now,
    });
  });

  it("can finish a legacy future interval through the existing desktop editor", async () => {
    const entry = await db.timeEntry.create({ data: { userId: actor.id, startsAt: future } });
    expect(
      await action(desktop, locale, { ...form, _action: "edit", id: entry.id, endTime: "10:00" }),
    ).toEqual({ ok: true });
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({
      startsAt: future,
      endsAt: new Date("2026-11-10T09:00:00Z"),
    });
    expect(emitChange).toHaveBeenCalledExactlyOnceWith({
      entityType: "timeEntry",
      id: entry.id,
      op: "updated",
    });
  });

  it.each(["desktop", "mobile"] as const)(
    "%s exact-now Stop is recoverable without writes and +1ms Stop succeeds",
    async (surface) => {
      const route = surface === "desktop" ? desktop : mobile;
      expect(await action(route, locale, { _action: "start-timer" })).toEqual({ ok: true });
      vi.mocked(emitChange).mockClear();
      const before = await snapshot();
      const result = await action(route, locale, { _action: "stop-timer" }).catch(
        (error: unknown) => error,
      );
      expect(await snapshot()).toEqual(before);
      expect(emitChange).not.toHaveBeenCalled();
      expect(result).toMatchObject({ error: t(locale, "work.err.time.futureTimerStop") });
      if (surface === "desktop") {
        expect(result).toMatchObject({
          fieldErrors: { startsAt: [t(locale, "work.err.time.futureTimerStop")] },
        });
      }
      const endsAt = new Date(now.getTime() + 1);
      vi.setSystemTime(endsAt);
      expect(await action(route, locale, { _action: "stop-timer" })).toEqual({ ok: true });
      const after = await snapshot();
      expect(after.entries[0]).toMatchObject({ startsAt: now, endsAt });
      const logs = after.audits.filter((log) => log.entityId === after.entries[0].id);
      expect(logs.filter((log) => log.action === "TimeEntryStopped")).toHaveLength(1);
      expect(logs.find((log) => log.action === "TimeEntryStopped")?.data).toMatchObject({
        minutes: 0,
      });
      expect(emitChange).toHaveBeenCalledExactlyOnceWith({
        entityType: "timeEntry",
        id: after.entries[0].id,
        op: "updated",
      });
    },
  );
});
