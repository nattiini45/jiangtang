import { describe, expect, it } from "vitest";
import { createLatestReader } from "../latest-reader";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLatestReader", () => {
  it("applies a read that finishes before any newer one starts", async () => {
    const latest = createLatestReader();
    const applied: string[] = [];
    await latest(
      async () => "a",
      (v) => applied.push(v),
    );
    await latest(
      async () => "b",
      (v) => applied.push(v),
    );
    expect(applied).toEqual(["a", "b"]);
  });

  it("drops an older read that resolves after a newer one", async () => {
    const latest = createLatestReader();
    const older = deferred<string>();
    const newer = deferred<string>();
    const applied: string[] = [];
    const first = latest(
      () => older.promise,
      (v) => applied.push(v),
    );
    const second = latest(
      () => newer.promise,
      (v) => applied.push(v),
    );
    newer.resolve("newer");
    await second;
    older.resolve("older");
    await first;
    expect(applied).toEqual(["newer"]);
  });

  it("drops an older read that resolves first while a newer one is still pending", async () => {
    const latest = createLatestReader();
    const older = deferred<string>();
    const newer = deferred<string>();
    const applied: string[] = [];
    const first = latest(
      () => older.promise,
      (v) => applied.push(v),
    );
    const second = latest(
      () => newer.promise,
      (v) => applied.push(v),
    );
    older.resolve("older");
    await first;
    // The newer read is the one the screen is waiting for.
    expect(applied).toEqual([]);
    newer.resolve("newer");
    await second;
    expect(applied).toEqual(["newer"]);
  });

  it("applies only the last of three reads resolving in reverse order", async () => {
    const latest = createLatestReader();
    const reads = [deferred<number>(), deferred<number>(), deferred<number>()];
    const applied: number[] = [];
    const runs = reads.map((r) =>
      latest(
        () => r.promise,
        (v) => applied.push(v),
      ),
    );
    reads[2]!.resolve(3);
    reads[1]!.resolve(2);
    reads[0]!.resolve(1);
    await Promise.all(runs);
    expect(applied).toEqual([3]);
  });

  it("a failed read rejects its own call without blocking later ones", async () => {
    const latest = createLatestReader();
    const applied: string[] = [];
    await expect(
      latest(
        async () => {
          throw new Error("boom");
        },
        (v: string) => applied.push(v),
      ),
    ).rejects.toThrow("boom");
    await latest(
      async () => "ok",
      (v) => applied.push(v),
    );
    expect(applied).toEqual(["ok"]);
  });
});
