/**
 * Guard for reads that can overlap: only the result of the most recently
 * started read is applied. A read that was overtaken is dropped when it
 * settles, even if it settles last, so slow storage cannot show an older
 * snapshot over a newer one.
 */
export function createLatestReader() {
  let latest = 0;
  return async function readLatest<T>(
    read: () => Promise<T>,
    apply: (value: T) => void,
  ): Promise<void> {
    const mine = ++latest;
    const value = await read();
    if (mine === latest) apply(value);
  };
}
