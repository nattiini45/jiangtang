import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import sharp from "sharp";
import { decryptBuffer, encryptBuffer } from "~/lib/storage/crypto.server";
import { UnsupportedImageError, processImage, sniffImageType } from "~/lib/storage/image.server";
import { FsStorageProvider } from "~/lib/storage/fs-provider";

/**
 * Storage primitives (no DB): encryption roundtrip, EXIF/GPS strip on ingest
 * (golden rule), magic-byte rejection, and the encrypted-FS provider roundtrip.
 */

async function makeJpeg(withExif = false): Promise<Buffer> {
  let pipeline = sharp({
    create: { width: 12, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  });
  if (withExif)
    pipeline = pipeline.withExif({ IFD0: { Copyright: "Jiangtang", Software: "exif-test" } });
  return pipeline.jpeg().toBuffer();
}

describe("storage crypto", () => {
  it("roundtrips encrypt → decrypt", async () => {
    const plain = Buffer.from("the bytes never live in postgres", "utf8");
    const blob = encryptBuffer(plain);
    expect(blob.equals(plain)).toBe(false); // ciphertext differs from plaintext
    expect(decryptBuffer(blob).equals(plain)).toBe(true);
  });

  it("rejects a tampered blob (GCM auth)", () => {
    const blob = encryptBuffer(Buffer.from("abc"));
    blob[blob.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptBuffer(blob)).toThrow();
  });
});

/**
 * Production key handling. resolveKey() caches the key per module instance, so every
 * case loads a fresh module after changing env (vi.resetModules + dynamic import) and
 * restores env and spies afterwards. The blob layout [iv(12) | authTag(16) | ciphertext]
 * is documented in crypto.server.ts; decryptIndependently uses node:crypto directly as an
 * oracle that does not go through the module under test.
 */
describe("storage crypto key configuration (production)", () => {
  type CryptoModule = typeof import("~/lib/storage/crypto.server");

  async function loadCrypto(): Promise<CryptoModule> {
    vi.resetModules();
    return import("~/lib/storage/crypto.server");
  }

  function decryptIndependently(blob: Buffer, key: Buffer): Buffer {
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const enc = blob.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("production refuses to encrypt or decrypt without STORAGE_ENCRYPTION_KEY (no dev-key fallback)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", undefined);
    const crypto = await loadCrypto();
    expect(() => crypto.encryptBuffer(Buffer.from("x"))).toThrow(
      /STORAGE_ENCRYPTION_KEY is required in production/,
    );
    expect(() => crypto.decryptBuffer(Buffer.alloc(64))).toThrow(
      /STORAGE_ENCRYPTION_KEY is required in production/,
    );

    // A whitespace-only value is treated as missing, not as a passphrase.
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", "   ");
    const blank = await loadCrypto();
    expect(() => blank.encryptBuffer(Buffer.from("x"))).toThrow(
      /STORAGE_ENCRYPTION_KEY is required in production/,
    );
  });

  it("a generated 64-hex key roundtrips and is used as the raw AES-256 key", async () => {
    const hex = randomBytes(32).toString("hex"); // same shape as `openssl rand -hex 32`
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", hex);
    vi.stubEnv("STORAGE_KEY_SALT", undefined);
    const crypto = await loadCrypto();

    const plain = Buffer.from("generated-key roundtrip", "utf8");
    const blob = crypto.encryptBuffer(plain);
    expect(crypto.decryptBuffer(blob).equals(plain)).toBe(true);
    // Independent oracle: the hex string is the key itself (no scrypt stretching).
    expect(decryptIndependently(blob, Buffer.from(hex, "hex")).equals(plain)).toBe(true);
  });

  it("a blob encrypted under one key fails authentication under another key", async () => {
    const keyA = randomBytes(32).toString("hex");
    const keyBBytes = Buffer.from(keyA, "hex");
    keyBBytes[0] ^= 0xff; // guaranteed different from keyA
    const keyB = keyBBytes.toString("hex");

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", keyA);
    const writer = await loadCrypto();
    const plain = Buffer.from("written under key A", "utf8");
    const blob = writer.encryptBuffer(plain);

    // Positive control in the same case: key A reads it back.
    const reader = await loadCrypto();
    expect(reader.decryptBuffer(blob).equals(plain)).toBe(true);

    // Negative control: key B must be refused by GCM authentication.
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", keyB);
    const wrong = await loadCrypto();
    expect(() => wrong.decryptBuffer(blob)).toThrow();
  });

  it("a custom STORAGE_KEY_SALT roundtrips and changes the passphrase-derived key", async () => {
    const passphrase = "correct horse battery staple, jiangtang test passphrase";
    const salt = "fresh-install-salt-2026-test";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", passphrase);
    vi.stubEnv("STORAGE_KEY_SALT", salt);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const writer = await loadCrypto();
    const plain = Buffer.from("custom salt roundtrip", "utf8");
    const blob = writer.encryptBuffer(plain);
    const reader = await loadCrypto();
    expect(reader.decryptBuffer(blob).equals(plain)).toBe(true);
    // Independent oracle: the key is scrypt(passphrase, customSalt, 32).
    expect(decryptIndependently(blob, scryptSync(passphrase, salt, 32)).equals(plain)).toBe(true);
    expect(warn).toHaveBeenCalled(); // passphrase guidance is logged outside NODE_ENV=test

    // Discriminating control: without the override the key differs, so the custom-salt key cannot read it.
    vi.stubEnv("STORAGE_KEY_SALT", undefined);
    const defaultSalt = await loadCrypto();
    const blobDefault = defaultSalt.encryptBuffer(plain);
    expect(() => decryptIndependently(blobDefault, scryptSync(passphrase, salt, 32))).toThrow();
  });
});

describe("image ingest", () => {
  it("sniffs supported types and rejects others", async () => {
    expect(sniffImageType(await makeJpeg())).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("not an image at all"))).toBeNull();
  });

  it("strips EXIF/GPS on ingest while preserving dimensions", async () => {
    const withExif = await makeJpeg(true);
    expect((await sharp(withExif).metadata()).exif).toBeTruthy(); // EXIF present going in

    const processed = await processImage(withExif);
    const meta = await sharp(processed.body).metadata();
    expect(meta.exif).toBeUndefined(); // stripped
    expect(meta.width).toBe(12);
    expect(meta.height).toBe(8);
    expect(processed.thumbnail.length).toBeGreaterThan(0);
  });

  it("rejects a non-image payload", async () => {
    await expect(processImage(Buffer.from("definitely not an image"))).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
  });

  it("rejects a corrupt image with a valid magic-byte prefix (not a raw 500)", async () => {
    const bogus = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("x".repeat(64)),
    ]);
    await expect(processImage(bogus)).rejects.toBeInstanceOf(UnsupportedImageError);
  });
});

describe("encrypted FS provider", () => {
  let dir = "";
  let provider: FsStorageProvider;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jiangtang-storage-"));
    provider = new FsStorageProvider(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("put → get roundtrips, writes ciphertext to disk, and stores a thumbnail", async () => {
    const img = await makeJpeg();
    const stored = await provider.put({
      body: img,
      contentType: "image/jpeg",
      category: "room",
      filename: "x.jpg",
    });

    expect(stored.objectKey).toMatch(/\.jpg$/);
    expect(stored.width).toBe(12);
    expect(stored.height).toBe(8);

    // On-disk bytes are encrypted (not the plaintext image).
    const onDisk = await readFile(join(dir, stored.objectKey.slice(0, 2), stored.objectKey));
    expect(onDisk.equals(img)).toBe(false);

    // get() decrypts back to a valid image.
    const got = await provider.get(stored.objectKey);
    expect((await sharp(got.body).metadata()).width).toBe(12);

    // thumbnail object is fetchable as jpeg
    const thumb = await provider.get(`${stored.objectKey}.thumb`);
    expect(thumb.contentType).toBe("image/jpeg");

    await provider.delete(stored.objectKey);
    await expect(provider.get(stored.objectKey)).rejects.toBeTruthy();
  });

  it("rejects object keys that could escape the shard directory", async () => {
    // get()/delete() take a caller-supplied key (see attachments.$key route) — a
    // traversal/absolute/backslash/NUL key must be rejected before touching disk.
    const bad = ["../../../etc/passwd", "/etc/passwd", "a\\..\\..\\secret", "a\0b", "..", ""];
    for (const key of bad) {
      await expect(provider.get(key)).rejects.toThrow(/Invalid object key/);
      await expect(provider.delete(key)).rejects.toThrow(/Invalid object key/);
    }
  });
});
