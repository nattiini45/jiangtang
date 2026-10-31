import * as React from "react";
import type { MessageKey, MessageParams, Translate } from "./index";

/**
 * Translate a message whose `{placeholder}`s are React nodes (a `<strong>`, a
 * `<code>`): the node slots are swapped for sentinels, the message is
 * interpolated as usual, then split back apart around the sentinels so each
 * translation keeps its own word order.
 */
const SENTINEL = "\u0000";

export function tRich(
  t: Translate,
  key: MessageKey,
  nodes: Record<string, React.ReactNode>,
  params?: MessageParams,
): React.ReactNode {
  const slots: MessageParams = { ...params };
  for (const name of Object.keys(nodes)) slots[name] = `${SENTINEL}${name}${SENTINEL}`;
  return t(key, slots)
    .split(SENTINEL)
    .map((part, i) =>
      i % 2 === 1 ? <React.Fragment key={i}>{nodes[part]}</React.Fragment> : part,
    );
}
