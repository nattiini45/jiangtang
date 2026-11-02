import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The fixed insecure storage key is reachable only from an explicit development or
 * test run. An unset NODE_ENV, or any other value, must require STORAGE_ENCRYPTION_KEY.
 * resolveKey() caches per module instance, so each case loads a fresh module.
 */

type CryptoModule = typeof import("~/lib/storage/crypto.server");

async function loadCrypto(): Promise<CryptoModule> {
  vi.resetModules();
  return import("~/lib/storage/crypto.server");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("storage key fallback is gated on an explicit NODE_ENV", () => {
  it.each([undefined, "production", "staging"] as const)(
    "refuses the insecure dev key when NODE_ENV is %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("STORAGE_ENCRYPTION_KEY", undefined);
      const crypto = await loadCrypto();

      expect(() => crypto.encryptBuffer(Buffer.from("x"))).toThrow(
        /STORAGE_ENCRYPTION_KEY is required/,
      );
    },
  );

  it.each(["development", "test"])(
    "uses the insecure dev key when NODE_ENV is %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("STORAGE_ENCRYPTION_KEY", undefined);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const crypto = await loadCrypto();

      const plain = Buffer.from("dev roundtrip", "utf8");
      expect(crypto.decryptBuffer(crypto.encryptBuffer(plain)).equals(plain)).toBe(true);
    },
  );
});
