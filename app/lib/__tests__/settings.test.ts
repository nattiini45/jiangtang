import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { db } from "~/lib/db.server";
import {
  getSecretSetting,
  getSetting,
  hasSecretSetting,
  updateSettings,
} from "~/lib/settings.server";

const keys: string[] = [];
function key() {
  const key = `settings-test.${randomUUID()}`;
  keys.push(key);
  return key;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.setting.deleteMany({ where: { key: { in: keys.splice(0) } } });
});

it("resolves environment, stored value and default in that order", async () => {
  let pinned: number | undefined;
  const setting = {
    key: key(),
    schema: z.number().int().positive(),
    defaultValue: 10,
    readEnvironment: () => pinned,
  };
  expect(await getSetting(setting)).toBe(10);
  await updateSettings({}, (write) => write.set(setting, 20));
  expect(await getSetting(setting)).toBe(20);
  pinned = 30;
  expect(await getSetting(setting)).toBe(30);
  await expect(updateSettings({}, (write) => write.set(setting, 40))).rejects.toThrow("pinned");
  pinned = undefined;
  expect(await getSetting(setting)).toBe(20);
});

it("stores secrets as authenticated ciphertext with no plaintext in audit or public reads", async () => {
  const name = key();
  const other = key();
  const secret = "Synthetic credential";
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "aa".repeat(32));
  await updateSettings({}, (write) => write.setSecret(name, secret));
  const row = await db.setting.findUniqueOrThrow({ where: { key: name } });
  expect(row.value).toBeNull();
  expect(row.ciphertext).not.toBeNull();
  expect(Buffer.from(row.ciphertext!).includes(secret)).toBe(false);
  expect(await hasSecretSetting(name)).toBe(true);
  expect(await getSecretSetting(name)).toBe(secret);
  expect(await getSetting({ key: name, schema: z.string(), defaultValue: "unset" })).toBe("unset");
  expect(
    await db.activityLog.findMany({ where: { entityId: name }, select: { data: true } }),
  ).toEqual([{ data: { secret: true } }]);

  await db.setting.create({ data: { key: other, ciphertext: row.ciphertext } });
  await expect(getSecretSetting(other)).rejects.toThrow();
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "bb".repeat(32));
  await expect(getSecretSetting(name)).rejects.toThrow();
  await updateSettings({}, (write) => write.setSecret(name, null));
  expect(await hasSecretSetting(name)).toBe(false);
  expect(await getSecretSetting(name)).toBeNull();
});

it("derives a key from the auth secret when no dedicated key is set", async () => {
  const name = key();
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-auth-secret");
  await updateSettings({}, (write) => write.setSecret(name, "Synthetic credential"));
  expect(await getSecretSetting(name)).toBe("Synthetic credential");
  vi.stubEnv("BETTER_AUTH_SECRET", "different-synthetic-auth-secret");
  await expect(getSecretSetting(name)).rejects.toThrow();
});

it("refuses to replace a stored value with the opposite storage format", async () => {
  const publicSetting = { key: key(), schema: z.string(), defaultValue: "unset" };
  const secretSetting = { ...publicSetting, key: key() };
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "aa".repeat(32));
  await updateSettings({}, async (write) => {
    await write.set(publicSetting, "public");
    await write.setSecret(secretSetting.key, "Synthetic credential");
  });
  await expect(
    updateSettings({}, (write) => write.setSecret(publicSetting.key, "Synthetic credential")),
  ).rejects.toThrow("setting_one_value");
  await expect(updateSettings({}, (write) => write.set(secretSetting, "public"))).rejects.toThrow(
    "setting_one_value",
  );
  expect(await getSetting(publicSetting)).toBe("public");
  expect(await getSecretSetting(secretSetting.key)).toBe("Synthetic credential");
});

it("rolls back a settings update and its audit when the secret cannot be encrypted", async () => {
  const setting = { key: key(), schema: z.boolean(), defaultValue: false };
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", undefined);
  vi.stubEnv("BETTER_AUTH_SECRET", undefined);
  const secretKey = key();
  await expect(
    updateSettings({}, async (write) => {
      await write.set(setting, true);
      await write.setSecret(secretKey, "Synthetic credential");
    }),
  ).rejects.toThrow("No settings encryption key");
  expect(await getSetting(setting)).toBe(false);
  expect(
    await db.activityLog.count({ where: { entityId: { in: [setting.key, secretKey] } } }),
  ).toBe(0);
});

it("rejects rows with both value formats or neither", async () => {
  await expect(
    db.setting.create({ data: { key: key(), value: "public", ciphertext: new Uint8Array(28) } }),
  ).rejects.toThrow("setting_one_value");
  await expect(db.setting.create({ data: { key: key() } })).rejects.toThrow("setting_one_value");
});
