import type { Transition } from "motion/react";

/**
 * The three motion tiers. The bigger the thing that moves, the slower the tier:
 * `fast` for hover, fades, tooltips and focus; `moderate` for menus, tabs,
 * drawers and a selection gliding between rows; `slow` for dialogs and sheets.
 * Never hand-write a duration in a component; reach for a tier.
 *
 * `exit` is a plain tween one step quicker than the enter, so a dismissal reads
 * as final instead of replaying the entrance backwards. Pass it as the
 * `transition` of an `exit` prop.
 */
type Tier = Transition & { exit: Transition };

export const spring = {
  fast: { type: "spring", duration: 0.08, bounce: 0, exit: { duration: 0.06, ease: "easeIn" } },
  // Critically damped: lands exactly, so it also carries panels that must settle.
  moderate: {
    type: "spring",
    duration: 0.16,
    bounce: 0,
    exit: { duration: 0.12, ease: "easeIn" },
  },
  slow: { type: "spring", duration: 0.24, bounce: 0.12, exit: { duration: 0.16, ease: "easeIn" } },
} satisfies Record<string, Tier>;
