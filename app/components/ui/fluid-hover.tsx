import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "~/lib/utils";
import { spring } from "~/lib/springs";

/**
 * Fluid hover: one highlight per list that glides from row to row under the
 * pointer instead of each row blinking its own background. Only click targets
 * register (`itemProps(i)` on a link or button), rows should touch (no gap) so
 * the highlight never drops out between them, and a pointer entering the list
 * fades the highlight in where it lands rather than sliding over from where it
 * was last. Skip it where a wrong click hurts or rows move under the pointer
 * (drag boards, virtualized grids).
 *
 * The container must be `position: relative`; render `<FluidHoverHighlight>`
 * as its first child so the rows paint above it. Keyboard code calls
 * `setActiveIndex` so keyboard and pointer focus look the same.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FluidHover<T extends HTMLElement = HTMLElement> {
  containerRef: React.RefObject<T | null>;
  handlers: {
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerLeave: (e: React.PointerEvent) => void;
  };
  itemProps: (index: number) => { "data-fluid-index": number };
  activeIndex: number | null;
  setActiveIndex: (index: number | null) => void;
  rect: Rect | null;
  session: number;
}

const ITEM = "[data-fluid-index]";

// Offsets, not getBoundingClientRect: they ignore transforms, so a popup that is
// still scaling in measures where its rows will land.
function measure(container: HTMLElement, item: HTMLElement): Rect {
  let x = 0;
  let y = 0;
  let el: HTMLElement | null = item;
  while (el && el !== container) {
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent as HTMLElement | null;
  }
  if (el !== container) {
    // The container is not the rows' offset parent; fall back to layout boxes.
    const c = container.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    x = r.left - c.left - container.clientLeft + container.scrollLeft;
    y = r.top - c.top - container.clientTop + container.scrollTop;
  }
  return { x, y, width: item.offsetWidth, height: item.offsetHeight };
}

export function useFluidHover<T extends HTMLElement = HTMLElement>(): FluidHover<T> {
  const containerRef = React.useRef<T | null>(null);
  const [state, setState] = React.useState<{ index: number; rect: Rect } | null>(null);
  const [session, setSession] = React.useState(0);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const setActiveIndex = React.useCallback((index: number | null) => {
    const container = containerRef.current;
    if (index === null || !container) {
      if (stateRef.current) setState(null);
      return;
    }
    const item = container.querySelector<HTMLElement>(`[data-fluid-index="${index}"]`);
    if (!item) return;
    const rect = measure(container, item);
    const prev = stateRef.current;
    if (
      prev &&
      prev.index === index &&
      prev.rect.x === rect.x &&
      prev.rect.y === rect.y &&
      prev.rect.width === rect.width &&
      prev.rect.height === rect.height
    ) {
      return;
    }
    // A fresh entry fades in where it lands instead of sliding from the last row.
    if (!prev) setSession((s) => s + 1);
    setState({ index, rect });
  }, []);

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const container = containerRef.current;
      const item = (e.target as Element | null)?.closest<HTMLElement>(ITEM);
      if (
        !container ||
        !item ||
        !container.contains(item) ||
        item.matches(":disabled, [aria-disabled='true']")
      ) {
        setActiveIndex(null);
        return;
      }
      setActiveIndex(Number(item.dataset.fluidIndex));
    },
    [setActiveIndex],
  );

  const onPointerLeave = React.useCallback(() => setActiveIndex(null), [setActiveIndex]);

  const itemProps = React.useCallback((index: number) => ({ "data-fluid-index": index }), []);

  return {
    containerRef,
    handlers: { onPointerMove, onPointerLeave },
    itemProps,
    activeIndex: state?.index ?? null,
    setActiveIndex,
    rect: state?.rect ?? null,
    session,
  };
}

export function FluidHoverHighlight<T extends HTMLElement>({
  hover,
  className,
}: {
  hover: FluidHover<T>;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const rect = hover.rect;
  return (
    <AnimatePresence initial={false}>
      {rect ? (
        <motion.div
          key={hover.session}
          aria-hidden
          className={cn("bg-hover pointer-events-none absolute top-0 left-0 rounded-md", className)}
          style={{ width: rect.width, height: rect.height }}
          initial={{ opacity: 0, x: rect.x, y: rect.y }}
          animate={{ opacity: 1, x: rect.x, y: rect.y }}
          exit={{ opacity: 0, transition: spring.fast.exit }}
          // Reduced motion: travel snaps, the fade stays.
          transition={
            reduce ? { x: { duration: 0 }, y: { duration: 0 }, ...spring.fast } : spring.fast
          }
        />
      ) : null}
    </AnimatePresence>
  );
}
