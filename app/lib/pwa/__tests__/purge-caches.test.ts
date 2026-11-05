import { describe, expect, it, vi } from "vitest";
import { purgeSignedInCaches } from "../purge-caches";

/** The part of CacheStorage the purge touches, backed by a set of names. */
function fakeStorage(names: string[]) {
  const live = new Set(names);
  return {
    live,
    storage: {
      keys: async () => [...live],
      delete: async (name: string) => live.delete(name),
    } as unknown as CacheStorage,
  };
}

describe("purgeSignedInCaches", () => {
  it("deletes every shell cache, of any version, and keeps the asset cache", async () => {
    const { live, storage } = fakeStorage([
      "jiangtang-shell-v1",
      "jiangtang-shell-v2",
      "jiangtang-assets-v1",
      "someone-elses-cache",
    ]);

    const removed = await purgeSignedInCaches(storage);

    expect(removed.sort()).toEqual(["jiangtang-shell-v1", "jiangtang-shell-v2"]);
    expect([...live].sort()).toEqual(["jiangtang-assets-v1", "someone-elses-cache"]);
  });

  it("is a no-op without CacheStorage (insecure origin, old browser)", async () => {
    await expect(purgeSignedInCaches(undefined)).resolves.toEqual([]);
  });

  it("never throws: a storage failure must not break the sign-in page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = {
      keys: async () => {
        throw new Error("storage unavailable");
      },
    } as unknown as CacheStorage;

    await expect(purgeSignedInCaches(storage)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
