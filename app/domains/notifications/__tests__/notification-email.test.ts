import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { getJobQueue, startJobQueue, stopJobQueue } from "~/lib/jobs.server";
import { openSecret } from "~/lib/settings.server";
import { deliverMail, MAIL_QUEUE, registerMailWorker, saveSmtp } from "~/domains/mail/mail.server";
import {
  notifyBookingConflict,
  notifyWarrantyExpiring,
  sweepDueSoon,
} from "~/domains/notifications/notifications.mutations.server";
import {
  createTaskInTx,
  createTask,
  setTaskAssignees,
} from "~/domains/tasks/tasks.mutations.server";

const marker = randomUUID();
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("nodemailer", () => ({ createTransport: () => ({ sendMail }) }));

const emails = [`${marker}-one@example.test`, `${marker}-two@example.test`];
const baseUrl = "https://workspace.example.test";
const actor = {};
const taskInput = { title: `Sound check ${marker}`, body: "", status: "TODO" as const, labels: [] };
const smtp = {
  host: "smtp.example.test",
  port: 587,
  tls: "starttls" as const,
  from: "sender@example.test",
  username: "synthetic-login",
  password: "synthetic credential",
  enabled: true,
  clearPassword: false,
};
let first: string;
let second: string;

function deliveries() {
  return db.mailDelivery.findMany({ where: { recipient: { in: emails } } });
}

function message(row: Awaited<ReturnType<typeof deliveries>>[number]) {
  return JSON.parse(openSecret(`mail:${row.id}`, row.payload!));
}

beforeAll(async () => {
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "d4".repeat(32));
  vi.stubEnv("BETTER_AUTH_URL", baseUrl);
  await startJobQueue();
  await registerMailWorker();
  await getJobQueue()!.offWork(MAIL_QUEUE, { wait: true });
  first = (
    await db.user.create({
      data: { email: emails[0]!, name: "Fixture One", emailVerified: true, role: "ADMIN" },
    })
  ).id;
  second = (
    await db.user.create({
      data: { email: emails[1]!, name: "Fixture Two", emailVerified: true, role: "ADMIN" },
    })
  ).id;
});

beforeEach(async () => {
  await saveSmtp(actor, smtp);
});

afterEach(async () => {
  await db.notification.deleteMany({ where: { userId: { in: [first, second] } } });
  await db.task.deleteMany({ where: { title: { contains: marker } } });
  await db.event.deleteMany({ where: { title: { contains: marker } } });
  await db.mailDelivery.deleteMany({ where: { recipient: { in: emails } } });
  await getJobQueue()!.deleteAllJobs(MAIL_QUEUE);
});

afterAll(async () => {
  try {
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await db.setting.deleteMany({ where: { key: "smtp" } });
  } finally {
    await stopJobQueue();
    vi.unstubAllEnvs();
  }
});

it("commits one assignment notification and one queued mail with a direct link", async () => {
  const task = await createTask(actor, taskInput);
  await setTaskAssignees(actor, task.id, [{ userId: first }]);
  await setTaskAssignees(actor, task.id, [{ userId: first }]);
  const [row, ...others] = await deliveries();
  expect(others).toEqual([]);
  expect(row).toMatchObject({
    recipient: emails[0],
    status: "queued",
    kind: "notification:TASK_ASSIGNED",
  });
  expect(message(row!)).toMatchObject({
    subject: `Dir zugewiesen: „${task.title}“`,
    text: expect.stringContaining(`${baseUrl}/tasks/${task.id}`),
  });
  expect(await getJobQueue()!.findJobs(MAIL_QUEUE)).toMatchObject([{ data: { id: row!.id } }]);
  expect(await db.notification.findMany({ where: { entityId: task.id } })).toMatchObject([
    { userId: first, type: "TASK_ASSIGNED" },
  ]);
});

it("rolls the assignment, inbox notification and mail back together", async () => {
  await expect(
    txWithAudit(actor, async (tx, audit) => {
      const task = await createTaskInTx(tx, audit, actor, taskInput, [{ userId: first }]);
      expect(await tx.notification.count({ where: { entityId: task.id, userId: first } })).toBe(1);
      expect(
        await tx.mailDelivery.count({ where: { recipient: emails[0], status: "queued" } }),
      ).toBe(1);
      throw new Error("roll back");
    }),
  ).rejects.toThrow("roll back");
  expect(await db.task.count({ where: { title: taskInput.title } })).toBe(0);
  expect(await db.notification.count({ where: { userId: first } })).toBe(0);
  expect(await deliveries()).toEqual([]);
  expect(await getJobQueue()!.findJobs(MAIL_QUEUE)).toEqual([]);
});

it("keeps the assignment and inbox row if the optional mail queue fails", async () => {
  const send = vi.spyOn(getJobQueue()!, "send").mockRejectedValueOnce(new Error("queue offline"));
  try {
    const task = await createTask(actor, taskInput, [{ userId: first }]);
    expect(await db.notification.count({ where: { entityId: task.id, userId: first } })).toBe(1);
    expect(await deliveries()).toEqual([]);
    expect(await getJobQueue()!.findJobs(MAIL_QUEUE)).toEqual([]);
  } finally {
    send.mockRestore();
  }
});

it.each(["opted out", "unverified", "deactivated", "SMTP off", "SMTP missing"] as const)(
  "keeps the inbox notification but queues no mail when %s",
  async (state) => {
    await db.user.update({
      where: { id: first },
      data: {
        notificationEmailOptOuts: state === "opted out" ? ["TASK_ASSIGNED"] : [],
        emailVerified: state !== "unverified",
        isActive: state !== "deactivated",
      },
    });
    if (state === "SMTP off") await saveSmtp(actor, { ...smtp, enabled: false });
    if (state === "SMTP missing") await db.setting.delete({ where: { key: "smtp" } });
    try {
      const task = await createTask(actor, taskInput, [{ userId: first }]);
      expect(await db.notification.count({ where: { entityId: task.id, userId: first } })).toBe(1);
      expect(await deliveries()).toEqual([]);
      expect(await getJobQueue()!.findJobs(MAIL_QUEUE)).toEqual([]);
    } finally {
      await db.user.update({
        where: { id: first },
        data: { notificationEmailOptOuts: [], emailVerified: true, isActive: true },
      });
    }
  },
);

it("sends a booking conflict to each organizer with a link to their own event", async () => {
  const events = await db.event.createManyAndReturn({
    data: emails.map((organizer, i) => ({
      title: `Event ${i} ${marker}`,
      organizer,
      startsAt: new Date("2030-05-01T08:00:00Z"),
      endsAt: new Date("2030-05-01T09:00:00Z"),
    })),
  });
  await notifyBookingConflict({
    actor,
    entityType: "eventRoomBooking",
    entityId: null,
    conflictingEventIds: events.map(({ id }) => id),
    detail: {},
  });
  const rows = await deliveries();
  expect(rows).toHaveLength(2);
  for (const event of events) {
    const row = rows.find(({ recipient }) => recipient === event.organizer);
    expect(message(row!)).toMatchObject({
      subject: expect.stringContaining(event.title),
      text: expect.stringContaining(`${baseUrl}/events/${event.id}`),
    });
  }
});

it("does not deliver queued mail after the recipient is deactivated", async () => {
  await createTask(actor, taskInput, [{ userId: first }]);
  const [row] = await deliveries();
  await db.user.update({ where: { id: first }, data: { isActive: false } });
  try {
    await deliverMail({ data: { id: row!.id }, retryCount: 0, retryLimit: 4 });
    expect(sendMail).not.toHaveBeenCalled();
    expect(await deliveries()).toMatchObject([
      { status: "skipped", reason: "recipientUnavailable", payload: null },
    ]);
  } finally {
    await db.user.update({ where: { id: first }, data: { isActive: true } });
  }
});

it("groups only new due tasks and warranty items by recipient and sweep", async () => {
  const dueAt = new Date(Date.now() + 60 * 60 * 1000);
  const both = await createTask(actor, { ...taskInput, dueAt }, [
    { userId: first },
    { userId: second },
  ]);
  const extra = await createTask(actor, { ...taskInput, title: `Extra ${marker}`, dueAt }, [
    { userId: first },
  ]);
  const items = ["one", "two"].map((item) => ({
    id: `${marker}-${item}`,
    name: `Microphone ${item}`,
    warrantyExpiresAt: new Date("2030-05-01T08:00:00Z"),
  }));
  for (let run = 0; run < 2; run++) {
    await sweepDueSoon();
    await notifyWarrantyExpiring(items);
  }
  const due = (await deliveries()).filter((row) => row.kind === "notification:TASK_DUE_SOON");
  const warranty = (await deliveries()).filter(
    (row) => row.kind === "notification:WARRANTY_EXPIRING",
  );
  expect(due.map((row) => row.recipient).sort()).toEqual(emails);
  expect(warranty.map((row) => row.recipient).sort()).toEqual(emails);
  for (const row of due) {
    expect(message(row).text).toContain(`${baseUrl}/tasks/${both.id}`);
    expect(message(row).text.includes(`${baseUrl}/tasks/${extra.id}`)).toBe(
      row.recipient === emails[0],
    );
  }
  for (const row of warranty) {
    for (const item of items)
      expect(message(row).text).toContain(`${baseUrl}/inventory/stock/${item.id}`);
  }
});
