import { randomUUID } from "node:crypto";
import { createTransport } from "nodemailer";
import type { JobWithMetadata } from "pg-boss";
import { z } from "zod";
import { storedSmtpSchema, type SmtpConfig, type smtpSchema } from "~/domains/mail/mail.schema";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { db, type Tx } from "~/lib/db.server";
import { enqueueJob, getJobQueue } from "~/lib/jobs.server";
import { getSecretSetting, openSecret, sealSecret, updateSettings } from "~/lib/settings.server";
import { logger } from "~/lib/observability/logger.server";

export const MAIL_QUEUE = "mail-delivery";
const worker = globalThis as typeof globalThis & {
  jiangtangMailWorker?: ReturnType<typeof getJobQueue>;
};
const SETTING = "smtp";
const payloadSchema = z.object({
  subject: z.string(),
  text: z.string(),
  verifiedRecipientId: z.string().optional(),
});
const day = 86_400_000;

async function readSmtp(tx?: Tx) {
  const raw = await getSecretSetting(SETTING, tx);
  return raw ? storedSmtpSchema.parse(JSON.parse(raw)) : null;
}

export async function saveSmtp(
  actor: AuditActor,
  input: z.output<typeof smtpSchema> & { enabled: boolean; clearPassword: boolean },
) {
  const current = await readSmtp().catch((error: unknown) => {
    if (!input.password && !input.clearPassword) throw error;
    return null;
  });
  const { clearPassword, ...config } = input;
  const password = clearPassword ? "" : config.password || current?.password || "";
  if (password && !config.username) return false;
  const next = { ...config, password };
  if (
    current &&
    Object.entries(next).every(([key, value]) => current[key as keyof SmtpConfig] === value)
  ) {
    return true;
  }
  await updateSettings(actor, (write) =>
    write.setSecret(SETTING, JSON.stringify({ ...next, revision: randomUUID() })),
  );
  return true;
}

export async function readMailSettings() {
  let unreadable = false;
  const config = await readSmtp().catch(() => {
    unreadable = true;
    return null;
  });
  if (!config) return { config: null, passwordSet: false, ready: false, unreadable };
  const { password, ...visible } = config;
  const ready =
    config.enabled &&
    mailWorkerReady() &&
    Boolean(
      await db.mailDelivery.findFirst({
        where: { kind: "test", revision: config.revision, status: "sent" },
        select: { id: true },
      }),
    );
  return { config: visible, passwordSet: Boolean(password), ready, unreadable };
}

export function listMailDeliveries() {
  return db.mailDelivery.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      recipient: true,
      status: true,
      attempts: true,
      reply: true,
      reason: true,
      createdAt: true,
    },
  });
}

type Mail = z.output<typeof payloadSchema> & {
  kind: string;
  recipient: string;
  expiresAt?: Date;
};

export async function canQueueMail(tx: Tx) {
  return mailWorkerReady() && (await readSmtp(tx).catch(() => null))?.enabled === true;
}

export async function queueMail(
  tx: Tx,
  { kind, recipient, expiresAt, subject, text, verifiedRecipientId }: Mail,
) {
  const id = randomUUID();
  let reason: string | null = null;
  const config = await readSmtp(tx).catch(() => {
    reason = "configuration";
    return null;
  });
  if (!reason && !config?.enabled) reason = "disabled";
  if (!reason && !mailWorkerReady()) reason = "unavailable";
  const row = await tx.mailDelivery.create({
    data: {
      id,
      kind,
      recipient,
      revision: config?.revision,
      expiresAt: expiresAt ?? new Date(Date.now() + day),
      status: reason ? "skipped" : "queued",
      reason,
      finishedAt: reason ? new Date() : null,
      payload: reason
        ? null
        : sealSecret(`mail:${id}`, JSON.stringify({ subject, text, verifiedRecipientId })),
    },
    select: { id: true, status: true },
  });
  if (!reason) await enqueueJob(tx, MAIL_QUEUE, { id });
  return row;
}

export function queueTestMail(actor: AuditActor, mail: Omit<Mail, "kind">) {
  return txWithAudit(actor, async (tx, audit) => {
    const row = await queueMail(tx, { ...mail, kind: "test" });
    await audit({ action: "TestEmailRequested", entityType: "setting", entityId: SETTING });
    return row;
  });
}

function serverReply(reply: unknown, smtp: SmtpConfig, message: z.output<typeof payloadSchema>) {
  if (typeof reply !== "string") return null;
  let safe = reply;
  for (const secret of [smtp.password, smtp.username]) {
    if (secret) safe = safe.replaceAll(secret, "[redacted]");
  }
  for (const link of message.text.match(/https?:\/\/\S+/gi) ?? []) {
    safe = safe.replaceAll(link, "[redacted]");
  }
  return (
    safe
      .replace(/\p{C}+/gu, " ")
      .trim()
      .slice(0, 500) || null
  );
}

export function mailWorkerReady() {
  const queue = getJobQueue();
  return !!queue && worker.jiangtangMailWorker === queue;
}

export async function deliverMail(
  job: Pick<JobWithMetadata<{ id: string }>, "data" | "retryCount" | "retryLimit"> & {
    signal?: AbortSignal;
  },
) {
  const row = await db.mailDelivery.findUnique({ where: { id: job.data.id } });
  if (!row?.payload) return;
  let unreadable = false;
  const config = await readSmtp().catch(() => {
    unreadable = true;
    return null;
  });
  const reason = !config?.enabled
    ? unreadable
      ? "configuration"
      : "disabled"
    : row.revision !== config.revision
      ? "settingsChanged"
      : row.expiresAt.getTime() <= Date.now()
        ? "expired"
        : null;
  if (reason || !config) {
    await db.mailDelivery.update({
      where: { id: row.id },
      data: { status: "skipped", reason, payload: null, finishedAt: new Date() },
    });
    return;
  }
  const attempts = job.retryCount + 1;
  let message: z.output<typeof payloadSchema>;
  try {
    message = payloadSchema.parse(JSON.parse(openSecret(`mail:${row.id}`, row.payload)));
  } catch {
    await db.mailDelivery.update({
      where: { id: row.id },
      data: {
        attempts,
        status: "failed",
        reason: "configuration",
        payload: null,
        finishedAt: new Date(),
      },
    });
    return;
  }
  const { verifiedRecipientId, ...content } = message;
  if (
    verifiedRecipientId &&
    !(await db.user.count({
      where: { id: verifiedRecipientId, email: row.recipient, isActive: true, emailVerified: true },
    }))
  ) {
    await db.mailDelivery.update({
      where: { id: row.id },
      data: {
        status: "skipped",
        reason: "recipientUnavailable",
        payload: null,
        finishedAt: new Date(),
      },
    });
    return;
  }
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.tls === "tls",
    requireTLS: config.tls === "starttls",
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  let reply: string | null;
  let failure: "authentication" | "transport" | null = null;
  let retry = false;
  const timeout = AbortSignal.timeout(45_000);
  try {
    const info = await transport.sendMail({
      ...content,
      signal: job.signal ? AbortSignal.any([job.signal, timeout]) : timeout,
      from: config.from,
      to: row.recipient,
      messageId: `<${row.id}@${config.from.split("@")[1]}>`,
    });
    reply = serverReply(info.response, config, message);
  } catch (error) {
    const smtp = error as {
      code?: string;
      command?: string;
      response?: string;
      responseCode?: number;
    };
    const authFailure = smtp.code === "EAUTH" || smtp.command?.startsWith("AUTH");
    failure = authFailure ? "authentication" : "transport";
    const code = smtp.responseCode ?? 0;
    retry =
      job.retryCount < job.retryLimit && (authFailure ? code >= 400 && code < 500 : code < 500);
    reply = authFailure ? null : serverReply(smtp.response, config, message);
  }
  await db.mailDelivery.update({
    where: { id: row.id },
    data: {
      attempts,
      status: retry ? "retrying" : failure ? "failed" : "sent",
      reason: failure,
      reply,
      ...(retry ? {} : { payload: null, finishedAt: new Date() }),
    },
  });
  if (retry) throw new Error("SMTP delivery failed; will retry.");
}

export async function registerMailWorker() {
  const queue = getJobQueue();
  if (!queue) return;
  try {
    await queue.createQueue(MAIL_QUEUE, {
      retryLimit: 8,
      retryDelay: 120,
      retryBackoff: true,
      retryDelayMax: 1800,
      expireInSeconds: 120,
    });
    await queue.work<{ id: string }, void, { includeMetadata: true }>(
      MAIL_QUEUE,
      { includeMetadata: true },
      async ([job]) => {
        if (job) await deliverMail(job);
      },
    );
    worker.jiangtangMailWorker = queue;
  } catch {
    logger.error("[mail] Could not register the delivery queue; check pgboss permissions");
  }
}

export async function pruneMailDeliveries(now: Date) {
  const config = await readSmtp().catch(() => null);
  const proof = config
    ? await db.mailDelivery.findFirst({
        where: { kind: "test", revision: config.revision, status: "sent" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      })
    : null;
  const expired = await db.mailDelivery.updateMany({
    where: { finishedAt: null, expiresAt: { lte: now } },
    data: { status: "skipped", reason: "expired", payload: null, finishedAt: now },
  });
  const removed = await db.mailDelivery.deleteMany({
    where: {
      id: proof ? { not: proof.id } : undefined,
      finishedAt: { lt: new Date(now.getTime() - 30 * day) },
    },
  });
  return expired.count + removed.count;
}
