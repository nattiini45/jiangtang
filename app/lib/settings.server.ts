import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Prisma } from "~/generated/prisma/client";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { readConfig } from "~/lib/config.server";
import { db } from "~/lib/db.server";
import { emitChange } from "~/lib/realtime/emit.server";
import type { z } from "zod";

type PublicSetting<T extends Prisma.InputJsonValue> = {
  key: string;
  schema: z.ZodType<T>;
  defaultValue: T;
  readEnvironment?: () => T | undefined;
};

const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey() {
  const configured = readConfig("SETTINGS_ENCRYPTION_KEY");
  if (configured) {
    if (!/^[0-9a-f]{64}$/i.test(configured)) {
      throw new Error("SETTINGS_ENCRYPTION_KEY must contain 64 hex characters.");
    }
    return Buffer.from(configured, "hex");
  }
  const authSecret = readConfig("BETTER_AUTH_SECRET");
  if (!authSecret) throw new Error("No settings encryption key is configured.");
  return Buffer.from(hkdfSync("sha256", authSecret, "", "jiangtang-settings-v1", 32));
}

function seal(key: string, value: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(key));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

export async function getSetting<T extends Prisma.InputJsonValue>(setting: PublicSetting<T>) {
  const pinned = setting.readEnvironment?.();
  if (pinned !== undefined) return pinned;
  const row = await db.setting.findUnique({ where: { key: setting.key }, select: { value: true } });
  return row?.value == null ? setting.defaultValue : setting.schema.parse(row.value);
}

export async function hasSecretSetting(key: string) {
  return (await db.setting.count({ where: { key, ciphertext: { not: null } } })) > 0;
}

export async function getSecretSetting(key: string) {
  const row = await db.setting.findUnique({ where: { key }, select: { ciphertext: true } });
  if (!row?.ciphertext) return null;
  const blob = Buffer.from(row.ciphertext);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), blob.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(key));
  decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

type SettingsWriter = {
  set<T extends Prisma.InputJsonValue>(setting: PublicSetting<T>, value: T): Promise<void>;
  setSecret(key: string, value: string | null): Promise<void>;
};

export async function updateSettings(
  actor: AuditActor,
  update: (writer: SettingsWriter) => Promise<void>,
) {
  const changes = await txWithAudit(actor, async (tx, audit) => {
    const changes = new Map<string, "updated" | "deleted">();
    async function record(key: string, op: "updated" | "deleted", secret: boolean) {
      await audit({
        action: op === "deleted" ? "SettingRemoved" : "SettingChanged",
        entityType: "setting",
        entityId: key,
        data: { secret },
      });
      changes.set(key, op);
    }

    await update({
      async set(setting, value) {
        if (setting.readEnvironment?.() !== undefined) {
          throw new Error("This setting is pinned by the environment.");
        }
        const parsed = setting.schema.parse(value);
        await tx.setting.upsert({
          where: { key: setting.key },
          create: { key: setting.key, value: parsed },
          update: { value: parsed },
        });
        await record(setting.key, "updated", false);
      },
      async setSecret(key, value) {
        if (value === null) {
          const { count } = await tx.setting.deleteMany({
            where: { key, ciphertext: { not: null } },
          });
          if (count) await record(key, "deleted", true);
          return;
        }
        const ciphertext = seal(key, value);
        await tx.setting.upsert({
          where: { key },
          create: { key, ciphertext },
          update: { ciphertext },
        });
        await record(key, "updated", true);
      },
    });
    return changes;
  });
  for (const [id, op] of changes) await emitChange({ entityType: "setting", id, op });
}
