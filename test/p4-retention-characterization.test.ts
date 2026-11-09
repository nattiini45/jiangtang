import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { configuredCalendarFixture } from "./calendar-config";
import { db } from "~/lib/db.server";
import { auth } from "~/lib/auth.server";
import { createEvent, updateEvent } from "~/domains/events/events.mutations.server";
import { createInvite, resolveInvite, acceptInvite } from "~/domains/auth/users.queries.server";
import { createPasswordReset, resolvePasswordReset } from "~/domains/auth/password-reset.server";
import { markNotificationRead } from "~/domains/notifications/notifications.mutations.server";
import { calendarSyncHealth, drainOnce } from "~/lib/calendar/outbox.server";
import { loadFeedEvents, renderIcalFeed } from "~/lib/calendar/ical.server";
import type { CalendarPublisher } from "~/lib/calendar/publisher.server";

configuredCalendarFixture();
const RUN = `p4_probe_${crypto.randomUUID()}`;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY = 86_400_000;
const OLD = new Date(NOW.getTime() - 31 * DAY);
const eventIds: string[] = [];
const uids: string[] = [];
const userIds: string[] = [];
const emails: string[] = [];
const actor = { name: "Synthetic retention probe" };
const publisher: CalendarPublisher = { upsert: async () => {}, remove: async () => {} };
const input = (title: string) => ({
  title,
  description: `${title} description`,
  startsAt: "2026-11-10T10:00",
  endsAt: "2026-11-10T11:00",
  status: "PLANNED" as const,
});

async function event(title: string) {
  const row = await createEvent(actor, input(title));
  eventIds.push(row.id);
  uids.push(row.uid);
  return row;
}

async function snapshot(uid: string) {
  const feed = (
    await loadFeedEvents({
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-12-01T00:00:00Z"),
    })
  ).filter((row) => row.uid === uid);
  return {
    health: await calendarSyncHealth({ eventUidPrefix: uid }),
    feed,
    max: (await db.calendarOutbox.aggregate({ where: { eventUid: uid }, _max: { sequence: true } }))
      ._max.sequence,
    panel: await db.calendarOutbox.findFirst({
      where: { eventUid: uid },
      orderBy: { sequence: "desc" },
      select: { status: true, attempts: true, lastError: true, processedAt: true },
    }),
  };
}

afterEach(() => vi.useRealTimers());

afterAll(async () => {
  vi.useRealTimers();
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: uids } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.verification.deleteMany({
    where: { OR: [{ identifier: { in: emails } }, { value: { in: userIds } }] },
  });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("P4 stage-one real-database characterization only", () => {
  it("latest-only pruning loses a required SENT snapshot, health and obsolete-failure evidence", async () => {
    const row = await event("obsolete");
    await updateEvent(actor, row.id, input("A"));
    await updateEvent(actor, row.id, input("B"));
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid, sequence: { in: [0, 2] } },
      data: { status: "FAILED", attempts: 10, createdAt: OLD, lastError: "synthetic failure" },
    });
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid, sequence: 1 },
      data: { status: "SENT", processedAt: OLD, createdAt: OLD },
    });
    const sent = await db.calendarOutbox.findUniqueOrThrow({
      where: { eventUid_sequence: { eventUid: row.uid, sequence: 1 } },
    });
    expect(sent.payload).toMatchObject({ title: "A", description: "A description" });
    expect(await db.event.findUnique({ where: { id: row.id } })).toMatchObject({
      title: "B",
      description: "B description",
    });
    const before = await snapshot(row.uid);
    expect(before.health.lastSuccessAt).toEqual(OLD);
    expect(before.feed[0]).toMatchObject({ title: "B", sequence: 2 });
    expect(renderIcalFeed(before.feed)).toContain("SEQUENCE:2");
    const unpruned = await drainOnce(publisher, { now: NOW, eventUidPrefix: row.uid });
    expect(unpruned.superseded).toBe(1);
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid, sequence: 0 },
      data: { status: "FAILED", processedAt: null },
    });
    const removed = await db.$executeRaw`
      DELETE FROM "CalendarOutbox" AS o
      WHERE o."eventUid" = ${row.uid}
        AND o.status IN ('SENT', 'SUPERSEDED') AND o."processedAt" < ${new Date(NOW.getTime() - 30 * DAY)}
        AND o.sequence < (SELECT max(h.sequence) FROM "CalendarOutbox" h WHERE h."eventUid" = o."eventUid")`;
    expect(removed).toBe(1);
    const after = await snapshot(row.uid);
    expect(after.health.lastSuccessAt).toBeNull();
    expect(after.feed).toEqual(before.feed);
    expect(after.max).toBe(before.max);
    expect(after.panel).toEqual(before.panel);
    const pruned = await drainOnce(publisher, { now: NOW, eventUidPrefix: row.uid });
    expect(pruned.superseded).toBe(0);
    expect(await db.calendarOutbox.count({ where: { eventUid: row.uid, status: "FAILED" } })).toBe(
      2,
    );
    console.log(
      "P4 latest-only counterexample",
      JSON.stringify({ before, after, unpruned, pruned }),
    );
  });

  it("max SENT sequence and latest SENT timestamp can identify different rows through the real worker", async () => {
    const row = await event("A");
    await drainOnce(publisher, { now: OLD, eventUidPrefix: row.uid });
    await updateEvent(actor, row.id, input("B"));
    const earlierClock = new Date(OLD.getTime() - DAY);
    await drainOnce(publisher, { now: earlierClock, eventUidPrefix: row.uid });
    const sent = await db.calendarOutbox.findMany({
      where: { eventUid: row.uid, status: "SENT" },
      orderBy: { sequence: "desc" },
    });
    expect(sent.map((r) => [r.sequence, r.processedAt])).toEqual([
      [1, earlierClock],
      [0, OLD],
    ]);
    expect((await calendarSyncHealth({ eventUidPrefix: row.uid })).lastSuccessAt).toEqual(OLD);
    console.log(
      "P4 clock reversal",
      JSON.stringify(sent.map(({ sequence, processedAt }) => ({ sequence, processedAt }))),
    );
  });

  it("a three-anchor synthetic candidate preserves sequence, health and panel without retaining all old history", async () => {
    const row = await event("A");
    for (let i = 1; i <= 5; i++) await updateEvent(actor, row.id, input(`B${i}`));
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid },
      data: { status: "SUPERSEDED", processedAt: OLD, createdAt: OLD },
    });
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid, sequence: { in: [1, 3, 4] } },
      data: { status: "SENT", processedAt: new Date(OLD.getTime() - DAY) },
    });
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid, sequence: 3 },
      data: { processedAt: OLD },
    });
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid, sequence: 0 },
      data: { status: "FAILED", processedAt: null, attempts: 10 },
    });
    const before = await snapshot(row.uid);
    const deleted = await db.$executeRaw`
      DELETE FROM "CalendarOutbox" AS o
      WHERE o."eventUid" = ${row.uid}
        AND o.status IN ('SENT', 'SUPERSEDED')
        AND o."processedAt" < ${new Date(NOW.getTime() - 30 * DAY)}
        AND NOT EXISTS (
          SELECT 1 FROM "Event" e WHERE e.uid = o."eventUid"
          AND o.sequence = (SELECT max(h.sequence) FROM "CalendarOutbox" h WHERE h."eventUid" = o."eventUid")
        )
        AND o.sequence IS DISTINCT FROM (
          SELECT max(s.sequence) FROM "CalendarOutbox" s WHERE s."eventUid" = o."eventUid" AND s.status = 'SENT'
        )
        AND o.id IS DISTINCT FROM (
          SELECT g.id FROM "CalendarOutbox" g WHERE g.status = 'SENT' AND g."eventUid" = ${row.uid}
          ORDER BY g."processedAt" DESC NULLS LAST, g."eventUid" ASC, g.sequence DESC, g.id ASC LIMIT 1
        )`;
    expect(deleted).toBe(2);
    const after = await snapshot(row.uid);
    expect(after).toEqual(before);
    expect(
      (
        await db.calendarOutbox.findMany({
          where: { eventUid: row.uid },
          orderBy: { sequence: "asc" },
        })
      ).map((r) => r.sequence),
    ).toEqual([0, 3, 4, 5]);
    await updateEvent(actor, row.id, input("C"));
    expect((await snapshot(row.uid)).max).toBe(6);
    console.log(
      "P4 protected candidate",
      JSON.stringify({ before, after, deleted, retainedOldCompleted: [3, 4, 5] }),
    );
  });

  it("SENT NULL timestamps sort ahead of actual successes in existing health and need conservative handling", async () => {
    const row = await event("A");
    await updateEvent(actor, row.id, input("B"));
    await db.calendarOutbox.updateMany({ where: { eventUid: row.uid }, data: { status: "SENT" } });
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid, sequence: 0 },
      data: { processedAt: OLD },
    });
    expect((await calendarSyncHealth({ eventUidPrefix: row.uid })).lastSuccessAt).toBeNull();
    expect(
      await db.calendarOutbox.count({ where: { eventUid: row.uid, processedAt: { lt: NOW } } }),
    ).toBe(1);
  });

  it("selects one deterministic global timestamp anchor when successes tie across UIDs and sequences", async () => {
    const a = `${RUN}-tie-a`;
    const b = `${RUN}-tie-b`;
    uids.push(a, b);
    for (const uid of [b, a]) {
      for (const sequence of [1, 2]) {
        await db.calendarOutbox.create({
          data: {
            eventUid: uid,
            sequence,
            op: "UPSERT",
            status: "SENT",
            payload: { uid, sequence },
            processedAt: OLD,
          },
        });
      }
    }
    const selected = await db.$queryRaw<Array<{ eventUid: string; sequence: number }>>`
      SELECT "eventUid", sequence FROM "CalendarOutbox"
      WHERE "eventUid" IN (${a}, ${b}) AND status = 'SENT' AND "processedAt" IS NOT NULL
      ORDER BY "processedAt" DESC, "eventUid" ASC, sequence DESC, id ASC LIMIT 1`;
    expect(selected).toEqual([{ eventUid: a, sequence: 2 }]);
    expect((await calendarSyncHealth({ eventUidPrefix: `${RUN}-tie-` })).lastSuccessAt).toEqual(
      OLD,
    );
    console.log("P4 deterministic timestamp tie", JSON.stringify(selected));
  });

  it("a raw Event deletion leaves outbox rows orphaned rather than atomically removing an anchor", async () => {
    const row = await event("A");
    await db.calendarOutbox.updateMany({
      where: { eventUid: row.uid },
      data: { status: "SENT", processedAt: OLD },
    });
    await db.$executeRaw`DELETE FROM "Event" WHERE id = ${row.id}`;
    expect(await db.event.count({ where: { uid: row.uid } })).toBe(0);
    expect(await db.calendarOutbox.count({ where: { eventUid: row.uid } })).toBe(1);
    expect((await calendarSyncHealth({ eventUidPrefix: row.uid })).lastSuccessAt).toEqual(OLD);
    expect((await loadFeedEvents()).find((e) => e.uid === row.uid)).toBeUndefined();
    console.log(
      "P4 raw event deletion",
      JSON.stringify({ eventCount: 0, orphanOutboxCount: 1, lastSuccessAt: OLD }),
    );
  });

  it("characterizes exact session, invitation and reset expiry using only a fake Date clock and real database", async () => {
    const email = `${RUN}@example.test`;
    emails.push(email);
    const invite = await createInvite(
      { email, name: "Boundary", initials: "PFR", role: "MEMBER" },
      actor,
    );
    await db.verification.updateMany({ where: { identifier: email }, data: { expiresAt: NOW } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW.getTime() - 1));
    await expect(resolveInvite(invite)).resolves.toMatchObject({ email });
    vi.setSystemTime(NOW);
    await expect(resolveInvite(invite)).rejects.toThrow();
    vi.setSystemTime(new Date(NOW.getTime() + 1));
    await expect(resolveInvite(invite)).rejects.toThrow();
    await db.verification.updateMany({
      where: { identifier: email },
      data: { expiresAt: new Date(NOW.getTime() + DAY) },
    });
    const member = await acceptInvite(await resolveInvite(invite), "synthetic-password-123");
    userIds.push(member.id);
    const reset = await createPasswordReset(member.id, actor);
    await db.verification.updateMany({ where: { value: member.id }, data: { expiresAt: NOW } });
    vi.setSystemTime(new Date(NOW.getTime() - 1));
    await expect(resolvePasswordReset(reset)).resolves.toMatchObject({ userId: member.id });
    vi.setSystemTime(NOW);
    await expect(resolvePasswordReset(reset)).rejects.toThrow();
    vi.setSystemTime(new Date(NOW.getTime() + 1));
    await expect(resolvePasswordReset(reset)).rejects.toThrow();
    const origin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const signed = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password: "synthetic-password-123" }),
      }),
    );
    expect(signed.ok).toBe(true);
    const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("session_token");
    await db.session.updateMany({ where: { userId: member.id }, data: { expiresAt: NOW } });
    const results: boolean[] = [];
    for (const offset of [-1, 0, 1]) {
      vi.setSystemTime(new Date(NOW.getTime() + offset));
      const response = await auth.handler(
        new Request(`${origin}/api/auth/get-session?disableCookieCache=true&disableRefresh=true`, {
          headers: { cookie },
        }),
      );
      const result = await response.json();
      results.push(result !== null);
    }
    expect(results).toEqual([true, true, false]);
    console.log(
      "P4 exact expiry",
      JSON.stringify({
        offsetsMs: [-1, 0, 1],
        sessionAccepted: results,
        inviteAccepted: [true, false, false],
        resetAccepted: [true, false, false],
      }),
    );
  });

  it("characterizes completion-age and read-age boundaries without deleting production data", async () => {
    const row = await event("Age boundaries");
    const cutoff = new Date(NOW.getTime() - 30 * DAY);
    const payload = { uid: row.uid, title: "Age boundaries", sequence: 0 };
    await db.calendarOutbox.deleteMany({ where: { eventUid: row.uid } });
    const cases = [
      { status: "SENT" as const, processedAt: new Date(cutoff.getTime() - 1) },
      { status: "SENT" as const, processedAt: cutoff },
      { status: "SUPERSEDED" as const, processedAt: new Date(cutoff.getTime() + 1) },
      { status: "SENT" as const, processedAt: null },
      { status: "PENDING" as const, processedAt: OLD },
      { status: "FAILED" as const, processedAt: OLD },
      { status: "SUPERSEDED" as const, processedAt: new Date(cutoff.getTime() - 1) },
    ];
    for (const [sequence, data] of cases.entries())
      await db.calendarOutbox.create({
        data: {
          ...data,
          eventUid: row.uid,
          sequence,
          op: "UPSERT",
          payload,
          createdAt: new Date(NOW.getTime() - 365 * DAY),
        },
      });
    const eligible = await db.calendarOutbox.findMany({
      where: {
        eventUid: row.uid,
        status: { in: ["SENT", "SUPERSEDED"] },
        processedAt: { lt: cutoff },
      },
      orderBy: { sequence: "asc" },
    });
    expect(eligible.map((r) => r.sequence)).toEqual([0, 6]);
    const member = await db.user.create({
      data: { name: "Synthetic boundary", email: `${RUN}-notifications@example.test` },
    });
    userIds.push(member.id);
    const readCutoff = new Date(NOW.getTime() - 90 * DAY);
    const reads = [
      new Date(readCutoff.getTime() - 1),
      readCutoff,
      new Date(readCutoff.getTime() + 1),
      null,
    ];
    const notificationIds: string[] = [];
    for (const readAt of reads)
      notificationIds.push(
        (
          await db.notification.create({
            data: {
              userId: member.id,
              type: "TASK_ASSIGNED",
              readAt,
              createdAt: new Date(NOW.getTime() - 365 * DAY),
            },
          })
        ).id,
      );
    expect(
      (
        await db.notification.findMany({ where: { userId: member.id, readAt: { lt: readCutoff } } })
      ).map((r) => r.id),
    ).toEqual([notificationIds[0]]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await markNotificationRead({ id: member.id }, notificationIds[0]);
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: notificationIds[0] } })).readAt,
    ).toEqual(reads[0]);
    expect(
      await db.notification.count({ where: { userId: member.id, readAt: { lt: readCutoff } } }),
    ).toBe(1);
    console.log(
      "P4 age boundaries",
      JSON.stringify({
        outboxEligibleSequences: [0, 6],
        exactThirtyDaysRetained: true,
        nullProcessedRetained: true,
        pendingFailedRetained: true,
        exactNinetyDaysRetained: true,
        repeatedReadPreservesTimestamp: true,
      }),
    );
  });
});
