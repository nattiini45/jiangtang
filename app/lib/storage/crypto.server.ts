import { readConfig } from "~/lib/config.server";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encryption-at-rest for stored objects (AES-256-GCM): [iv(12) | authTag(16) |
 * ciphertext]. The key comes from STORAGE_ENCRYPTION_KEY (64 hex chars, or a
 * passphrase stretched with scrypt). Only an explicit development or test run may
 * fall back to an insecure fixed key (with a warning); every other environment,
 * including an unset NODE_ENV, requires the env var.
 *
 * The salt is source-committed and not secret. Changing it changes every derived
 * key, so stored objects of an existing installation would need re-encryption;
 * `STORAGE_KEY_SALT` is the operator override for a fresh installation.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function resolveSalt(): string {
  return readConfig("STORAGE_KEY_SALT");
}

function resolveKey(): Buffer {
  const raw = readConfig("STORAGE_ENCRYPTION_KEY");
  if (raw && raw.trim().length > 0) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    // A passphrase (not the recommended 64-hex-char key) is scrypt-stretched into
    // a 32-byte key. This still works, but scrypt's cost factor is a mitigation,
    // not a substitute for real key entropy — a weak/short passphrase is brute-
    // forceable. Warn so operators move to a generated 64-hex STORAGE_ENCRYPTION_KEY.
    if (readConfig("NODE_ENV") !== "test") {
      console.warn(
        "[storage] STORAGE_ENCRYPTION_KEY is not a 64-character hex string — deriving a key from it as a " +
          "passphrase via scrypt. For production, prefer a generated 64-hex-char key " +
          "(e.g. `openssl rand -hex 32`) over a passphrase.",
      );
    }
    return scryptSync(raw, resolveSalt(), 32);
  }
  const devOrTest = readConfig("NODE_ENV") === "development" || readConfig("NODE_ENV") === "test";
  if (!devOrTest) {
    throw new Error(
      "STORAGE_ENCRYPTION_KEY is required in production (object storage is encrypted at rest).",
    );
  }
  if (readConfig("NODE_ENV") !== "test") {
    console.warn(
      "[storage] STORAGE_ENCRYPTION_KEY not set — using an INSECURE dev key. Do not use in production.",
    );
  }
  return scryptSync("dev-insecure-storage-key", resolveSalt(), 32);
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  return (cachedKey ??= resolveKey());
}

export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptBuffer(blob: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("Corrupt stored object (too short).");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
