import { afterEach, describe, expect, it } from "vitest";
import { configuredCalendarFixture } from "../../../test/calendar-config";
import { db } from "~/lib/db.server";
import { pruneLifecycleData } from "~/lib/lifecycle-retention.boot.server";
import { calendarSyncHealth, drainOnce } from "~/lib/calendar/outbox.server";
import { loadFeedEvents } from "~/lib/calendar/ical.server";
import { createEvent, updateEvent } from "~/domains/events/events.mutations.server";
import type { OutboxStatus } from "~/generated/prisma/client";

configuredCalendarFixture();
const RUN = `lifecycle_${crypto.randomUUID()}`;
const NOW = new Date("2070-11-09T12:00:00Z");
const DAY = 86_400_000;
const OLD = new Date(NOW.getTime() - 31 * DAY);
const uids: string[] = [];
const eventIds: string[] = [];
const userIds: string[] = [];
const verificationIds: string[] = [];

function uid(label: string) {
  const value = `${RUN}-${label}`;
  uids.push(value);
  return value;
}

async function live(label: string) {
  const eventUid = uid(label);
  const row = await db.event.create({
    data: { uid: eventUid, title: "Current B", startsAt: NOW, endsAt: new Date(+NOW + DAY) },
  });
  eventIds.push(row.id);
  return eventUid;
}

async function outbox(
  eventUid: string,
  sequence: number,
  status: OutboxStatus,
  processedAt: Date | null = OLD,
) {
  return db.calendarOutbox.create({
    data: {
      eventUid,
      sequence,
      status,
      processedAt,
      op: "UPSERT",
      createdAt: new Date(+NOW - 365 * DAY),
      attempts: status === "FAILED" ? 10 : 0,
      payload: {
        uid: eventUid,
        sequence,
        title: "Historical A",
        startsAt: NOW.toISOString(),
        endsAt: new Date(+NOW + DAY).toISOString(),
      },
    },
  });
}

async function sequences(eventUid: string) {
  return (
    await db.calendarOutbox.findMany({ where: { eventUid }, orderBy: { sequence: "asc" } })
  ).map((r) => r.sequence);
}

afterEach(async () => {
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: uids } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.verification.deleteMany({ where: { id: { in: verificationIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("non-audit lifecycle retention", () => {
  it("deletes sessions/verifications at expiry, notifications strictly after 90 days, and is idempotent without changing users or audit", async () => {
    const user = await db.user.create({
      data: { email: `${RUN}@example.test`, name: "Synthetic", isActive: false },
    });
    userIds.push(user.id);
    for (const offset of [-1, 0, 1]) {
      const expiresAt = new Date(+NOW + offset);
      await db.session.create({ data: { token: `${RUN}-${offset}`, userId: user.id, expiresAt } });
      verificationIds.push(
        (await db.verification.create({ data: { identifier: RUN, value: "synthetic", expiresAt } }))
          .id,
      );
    }
    const readCutoff = new Date(+NOW - 90 * DAY);
    const reads = [new Date(+readCutoff - 1), readCutoff, new Date(+readCutoff + 1), null];
    const ids: string[] = [];
    for (const readAt of reads)
      ids.push(
        (
          await db.notification.create({
            data: {
              userId: user.id,
              type: "TASK_ASSIGNED",
              readAt,
              createdAt: new Date(+NOW - 365 * DAY),
            },
          })
        ).id,
      );
    const auditBefore = await db.activityLog.count();
    await pruneLifecycleData(NOW);
    await pruneLifecycleData(NOW);
    expect(
      (await db.session.findMany({ where: { userId: user.id } })).map((r) => r.expiresAt),
    ).toEqual([new Date(+NOW + 1)]);
    expect(
      (await db.verification.findMany({ where: { id: { in: verificationIds } } })).map(
        (r) => r.expiresAt,
      ),
    ).toEqual([new Date(+NOW + 1)]);
    expect(
      (await db.notification.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } }))
        .map((r) => r.id)
        .sort(),
    ).toEqual(ids.slice(1).sort());
    expect(await db.user.findUnique({ where: { id: user.id } })).toEqual(user);
    expect(await db.activityLog.count()).toBe(auditBefore);
  });

  it("uses completion time and strict elapsed 30-day boundaries while preserving active and unknown-time rows", async () => {
    const eventUid = await live("boundaries");
    const keeper = await live("recent-success");
    await outbox(keeper, 0, "SENT", NOW);
    const cutoff = new Date(+NOW - 30 * DAY);
    await outbox(eventUid, 0, "SENT", new Date(+cutoff - 1));
    await outbox(eventUid, 1, "SUPERSEDED", cutoff);
    await outbox(eventUid, 2, "SUPERSEDED", new Date(+cutoff + 1));
    await outbox(eventUid, 3, "SENT", null);
    await outbox(eventUid, 4, "PENDING");
    await outbox(eventUid, 5, "FAILED");
    await outbox(eventUid, 6, "SENT");
    await outbox(eventUid, 7, "SUPERSEDED");
    await pruneLifecycleData(NOW);
    expect(await sequences(eventUid)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await sequences(keeper)).toEqual([0]);
  });

  it("preserves distinct latest-sequence, highest-SENT and global timestamp anchors, feed and health", async () => {
    const eventUid = await live("anchors");
    await outbox(eventUid, 0, "FAILED");
    await outbox(eventUid, 1, "SENT", new Date(+OLD - DAY));
    await outbox(eventUid, 2, "SUPERSEDED");
    await outbox(eventUid, 3, "SENT", new Date(+OLD + DAY / 2));
    await outbox(eventUid, 4, "SENT");
    await outbox(eventUid, 5, "SUPERSEDED");
    const orphan = uid("quiescent-global-ineligible");
    await outbox(orphan, 0, "SENT", NOW);
    const before = await calendarSyncHealth({ eventUidPrefix: eventUid });
    const feedBefore = (await loadFeedEvents({ from: NOW, to: new Date(+NOW + DAY) })).filter(
      (e) => e.uid === eventUid,
    );
    await pruneLifecycleData(NOW);
    await pruneLifecycleData(NOW);
    expect(await sequences(eventUid)).toEqual([0, 3, 4, 5]);
    expect(await sequences(orphan)).toEqual([]);
    expect(await calendarSyncHealth({ eventUidPrefix: eventUid })).toEqual(before);
    expect(
      (await loadFeedEvents({ from: NOW, to: new Date(+NOW + DAY) })).filter(
        (e) => e.uid === eventUid,
      ),
    ).toEqual(feedBefore);
    expect(feedBefore[0]).toMatchObject({ title: "Current B", sequence: 5 });
    expect(
      (await db.calendarOutbox.findFirstOrThrow({ where: { eventUid, sequence: 3 } })).payload,
    ).toMatchObject({ title: "Historical A" });
  });

  it("chooses exactly one deterministic global timestamp anchor across tied UIDs", async () => {
    const a = await live("tie-a");
    const b = await live("tie-b");
    for (const eventUid of [b, a]) {
      await outbox(eventUid, 0, "SENT");
      await outbox(eventUid, 1, "SENT", new Date(+OLD - DAY));
      await outbox(eventUid, 2, "SUPERSEDED");
    }
    await pruneLifecycleData(NOW);
    expect(await sequences(a)).toEqual([0, 1, 2]);
    expect(await sequences(b)).toEqual([1, 2]);
  });

  it("retains SENT evidence for supersession behind a newer FAILED operation", async () => {
    const eventUid = await live("supersession");
    await outbox(eventUid, 0, "FAILED", null);
    await outbox(eventUid, 1, "SENT");
    await outbox(eventUid, 2, "FAILED", null);
    await pruneLifecycleData(NOW);
    expect(await sequences(eventUid)).toEqual([0, 1, 2]);
    expect((await calendarSyncHealth({ eventUidPrefix: eventUid })).lastSuccessAt).toEqual(OLD);
    const result = await drainOnce(
      { upsert: async () => {}, remove: async () => {} },
      { now: NOW, eventUidPrefix: eventUid },
    );
    expect(result.superseded).toBe(1);
    expect(await db.calendarOutbox.findFirst({ where: { eventUid, sequence: 0 } })).toMatchObject({
      status: "SUPERSEDED",
    });
    expect(await db.calendarOutbox.findFirst({ where: { eventUid, sequence: 2 } })).toMatchObject({
      status: "FAILED",
    });
  });

  it("removes quiescent orphan completions of every age, but protects anchors while PENDING or FAILED work remains", async () => {
    const gone = uid("gone");
    await outbox(gone, 0, "SENT", NOW);
    await outbox(gone, 1, "SUPERSEDED", null);
    await outbox(gone, 2, "SENT");
    const active = [uid("orphan-pending"), uid("orphan-failed")];
    for (const [index, eventUid] of active.entries()) {
      await outbox(eventUid, 0, "SENT");
      await outbox(eventUid, 1, "SUPERSEDED");
      await outbox(eventUid, 2, index === 0 ? "PENDING" : "FAILED", null);
      await outbox(eventUid, 3, "SUPERSEDED");
      await outbox(eventUid, 4, "SENT", null);
    }
    await pruneLifecycleData(NOW);
    expect(await sequences(gone)).toEqual([]);
    expect(await sequences(active[0]!)).toEqual([2, 4]);
    expect(await sequences(active[1]!)).toEqual([0, 2, 4]);
    await db.calendarOutbox.updateMany({
      where: { eventUid: { in: active }, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "SUPERSEDED", processedAt: NOW },
    });
    await pruneLifecycleData(NOW);
    for (const eventUid of active) expect(await sequences(eventUid)).toEqual([]);
  });

  it("does not lock Event rows or regress sequence allocation during a concurrent producer on a present Event", async () => {
    const actor = { name: "Synthetic retention producer" };
    const input = {
      title: "A",
      startsAt: "2070-11-09T13:00",
      endsAt: "2070-11-09T14:00",
      status: "PLANNED" as const,
    };
    const event = await createEvent(actor, input);
    eventIds.push(event.id);
    uids.push(event.uid);
    await updateEvent(actor, event.id, { ...input, title: "B" });
    await updateEvent(actor, event.id, { ...input, title: "C" });
    await db.calendarOutbox.updateMany({
      where: { eventUid: event.uid },
      data: { status: "SENT", processedAt: OLD },
    });
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let lockHeld = false;
    const lock = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${event.id} FOR UPDATE`;
        lockHeld = true;
        locked();
        await gate;
        lockHeld = false;
      },
      { timeout: 10_000 },
    );
    await acquired;
    let produced = false;
    const producer = updateEvent(actor, event.id, { ...input, title: "D" }).then((result) => {
      produced = true;
      return result;
    });
    try {
      await pruneLifecycleData(NOW);
      expect(lockHeld).toBe(true);
      expect(produced).toBe(false);
      expect(await sequences(event.uid)).toEqual([2]);
    } finally {
      release();
      await lock;
      await producer;
    }
    expect(await sequences(event.uid)).toEqual([2, 3]);
  });
});
