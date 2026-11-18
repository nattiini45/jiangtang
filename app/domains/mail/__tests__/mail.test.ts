import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { txWithAudit } from "~/lib/audit.server";
import { db } from "~/lib/db.server";
import { getJobQueue, startJobQueue, stopJobQueue } from "~/lib/jobs.server";
import {
  deliverMail,
  listMailDeliveries,
  MAIL_QUEUE,
  pruneMailDeliveries,
  queueMail,
  queueTestMail,
  readMailSettings,
  registerMailWorker,
  saveSmtp,
} from "~/domains/mail/mail.server";

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock("nodemailer", () => ({ createTransport }));

const recipient = "operator@example.test";
const originalPassword = "synthetic smtp credential";
const smtp = {
  host: "mail.example.test",
  port: 587,
  tls: "starttls" as const,
  from: "sender@example.test",
  username: "synthetic-login",
  password: originalPassword,
  enabled: true,
  clearPassword: false,
};
const mail = { recipient, subject: "Test message", text: "A synthetic message." };

async function clean() {
  await db.mailDelivery.deleteMany();
  await db.setting.deleteMany({ where: { key: "smtp" } });
  await getJobQueue()!.deleteAllJobs(MAIL_QUEUE);
}

beforeAll(async () => {
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "c3".repeat(32));
  await startJobQueue();
  await registerMailWorker();
  await getJobQueue()!.offWork(MAIL_QUEUE, { wait: true });
});

beforeEach(async () => {
  sendMail.mockReset();
  createTransport.mockClear();
  await clean();
});

afterAll(async () => {
  try {
    if (getJobQueue()) await clean();
  } finally {
    await stopJobQueue();
    vi.unstubAllEnvs();
  }
});

it("records a skipped message without a payload when email is off", async () => {
  expect(await readMailSettings()).toMatchObject({
    config: null,
    passwordSet: false,
    ready: false,
  });
  const row = await queueTestMail({}, mail);
  expect(await db.mailDelivery.findUnique({ where: { id: row.id } })).toMatchObject({
    status: "skipped",
    reason: "disabled",
    payload: null,
  });
  expect(await getJobQueue()!.findJobs(MAIL_QUEUE)).toEqual([]);
});

it("encrypts credentials and payloads, keeping both out of admin queries and the job", async () => {
  expect(await saveSmtp({}, smtp)).toBe(true);
  const setting = await db.setting.findUniqueOrThrow({ where: { key: "smtp" } });
  expect(setting.value).toBeNull();
  expect(Buffer.from(setting.ciphertext!).includes(originalPassword)).toBe(false);
  expect(await saveSmtp({}, { ...smtp, password: "" })).toBe(true);
  expect(await readMailSettings()).toMatchObject({ passwordSet: true, ready: false });
  expect(JSON.stringify(await readMailSettings())).not.toContain(originalPassword);
  const row = await queueTestMail({}, mail);
  const saved = await db.mailDelivery.findUniqueOrThrow({ where: { id: row.id } });
  expect(Buffer.from(saved.payload!).includes(mail.text)).toBe(false);
  expect(await getJobQueue()!.findJobs(MAIL_QUEUE)).toEqual([
    expect.objectContaining({ data: { id: row.id } }),
  ]);
  expect(JSON.stringify(await listMailDeliveries())).not.toContain("payload");
  sendMail.mockResolvedValueOnce({ response: `250 accepted ${originalPassword}` });
  await deliverMail({ data: { id: row.id }, retryCount: 0, retryLimit: 4 });
  expect(createTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      requireTLS: true,
      auth: { user: smtp.username, pass: originalPassword },
    }),
  );
  expect(await listMailDeliveries()).toMatchObject([
    { status: "sent", reply: "250 accepted [redacted]" },
  ]);
  expect(await db.mailDelivery.findUnique({ where: { id: row.id } })).toMatchObject({
    payload: null,
  });
  expect(await readMailSettings()).toMatchObject({ ready: true });
  await saveSmtp({}, { ...smtp, password: "" });
  expect(await readMailSettings()).toMatchObject({ ready: true });
  await pruneMailDeliveries(new Date(Date.now() + 31 * 86_400_000));
  expect(await readMailSettings()).toMatchObject({ ready: true });
});

it("rolls back the outbox and job together", async () => {
  await saveSmtp({}, smtp);
  await expect(
    txWithAudit(null, async (tx) => {
      await queueMail(tx, { ...mail, kind: "test" });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(await listMailDeliveries()).toEqual([]);
  expect(await getJobQueue()!.findJobs(MAIL_QUEUE)).toEqual([]);
});

it("records transient replies, retries and clears the payload on permanent failure", async () => {
  await saveSmtp({}, smtp);
  const row = await queueTestMail({}, mail);
  sendMail
    .mockRejectedValueOnce({ responseCode: 451, response: "451 try later" })
    .mockRejectedValueOnce({ responseCode: 550, response: "550 recipient rejected" });
  await expect(deliverMail({ data: { id: row.id }, retryCount: 0, retryLimit: 4 })).rejects.toThrow(
    "will retry",
  );
  expect(await listMailDeliveries()).toMatchObject([
    { status: "retrying", reply: "451 try later", attempts: 1 },
  ]);
  await deliverMail({ data: { id: row.id }, retryCount: 1, retryLimit: 4 });
  expect(await listMailDeliveries()).toMatchObject([
    { status: "failed", reply: "550 recipient rejected", attempts: 2 },
  ]);
  expect(await db.mailDelivery.findUnique({ where: { id: row.id } })).toMatchObject({
    payload: null,
  });
});

it("skips a pending message when its SMTP settings are replaced", async () => {
  await saveSmtp({}, smtp);
  const row = await queueTestMail({}, mail);
  await saveSmtp({}, { ...smtp, clearPassword: true });
  await deliverMail({ data: { id: row.id }, retryCount: 0, retryLimit: 4 });
  expect(sendMail).not.toHaveBeenCalled();
  expect(await listMailDeliveries()).toMatchObject([
    { status: "skipped", reason: "settingsChanged" },
  ]);
  expect(await readMailSettings()).toMatchObject({ ready: false, passwordSet: false });
});
