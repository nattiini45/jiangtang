export const WIDTHS_CHANGED = "jiangtang:column-widths";
export const MIN_WIDTH = 64;
export const MAX_WIDTH = 2000;
export type Widths = Record<string, number>;

export function widthKey(tableId = "list") {
  return `jiangtang:column-widths:${window.location.pathname}:${tableId}`;
}

export function readWidths(key: string): Widths {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, width]) =>
          typeof width === "number" &&
          Number.isFinite(width) &&
          width >= MIN_WIDTH &&
          width <= MAX_WIDTH,
      ),
    );
  } catch {
    return {};
  }
}

export function saveWidths(key: string, widths: Widths) {
  try {
    if (Object.keys(widths).length) localStorage.setItem(key, JSON.stringify(widths));
    else localStorage.removeItem(key);
  } catch {
    return;
  }
}

export function resetWidths(tableId?: string) {
  const key = widthKey(tableId);
  saveWidths(key, {});
  window.dispatchEvent(new CustomEvent(WIDTHS_CHANGED, { detail: key }));
}

export function layoutWidths(
  columns: { id: string; short: boolean; content: number }[],
  available: number,
  saved: Widths,
): Widths {
  const widths = Object.fromEntries(
    columns.map(({ id, short, content }) => [
      id,
      saved[id] ?? Math.max(short ? MIN_WIDTH : 160, Math.min(content, short ? 260 : 320)),
    ]),
  );
  const flexible = columns.filter(({ id, short }) => !short && saved[id] == null);
  const remaining = available - Object.values(widths).reduce((a, b) => a + b, 0);
  if (remaining >= 0 && flexible.length) {
    for (const { id } of flexible) widths[id] += remaining / flexible.length;
  } else if (available > 0 && remaining < 0) {
    const capacity = flexible.reduce((sum, { id }) => sum + widths[id] - 160, 0);
    const shrink = Math.min(-remaining, capacity);
    if (capacity)
      for (const { id } of flexible) widths[id] -= (shrink * (widths[id] - 160)) / capacity;
  }
  return widths;
}
