import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
} from "react";
import { Link, useFetcher } from "react-router";
import { GripHorizontal, GripVertical, Move } from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import {
  announce,
  bindDrag,
  bindDragPreview,
  createAutoScroll,
  definePrimitive,
  createMove,
  dragThreshold,
  type MovePoint,
} from "@ui-sdk/core";
import type { EventScheduleInput } from "~/domains/events/events.schema";
import { formatDateTime, formatTime } from "~/i18n/format";
import { useLocale, useT } from "~/i18n/use-t";
import { cn } from "~/lib/utils";

const hour = 3_600_000;
const quarter = hour / 4;
type Mode = EventScheduleInput["mode"];
type Item = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  track: number;
  booking?: {
    eventId: string;
    roomId: string;
    roomName: string;
    eventStartsAt: Date;
    eventEndsAt: Date;
  };
};
type Track = { slots: { instant: number; row: number }[]; room?: { id: string; name: string } };
type Target = { track: number; instant: number };
type Draft = {
  item: Item;
  mode: Mode;
  target: Target;
  keyboard: ReturnType<typeof keyboardMove>;
};

const keyboardMove = definePrimitive({
  name: "calendar-keyboard-move",
  options: { nudge: "callback", describe: "callback" },
  state: (_: { nudge: (dx: number, dy: number) => boolean; describe: () => string }) => ({
    positions: { card: { x: 0, y: 0 } } as Record<string, MovePoint>,
    moving: null,
  }),
  api: (context) => ({
    move: createMove(context, {
      key: "positions",
      draft: "moving",
      largeStep: () => 4,
      set: (positions) => {
        const { x, y } = context.store.get().positions.card;
        if (!context.options().nudge(positions.card.x - x, positions.card.y - y)) return false;
        context.store.set({ positions });
        return true;
      },
      message: () => context.options().describe(),
    }),
  }),
  slots: () => ({}),
  agent: { actions: [] },
});

export function useCalendarSchedule(tracks: Track[], horizontal = false) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const save = useFetcher<{ error: string | null }>();
  const draft = useRef<Draft | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const pending = useRef<{ item: Item; restore?: Mode } | null>(null);
  const [active, setActive] = useState<{ key: string; mode: Mode; text: string } | null>(null);
  const [feedback, setFeedback] = useState<{ key: string; error: string } | null>(null);
  const time = (item: Item, mode: Mode) =>
    +new Date(mode === "resize" ? item.endsAt : item.startsAt);
  const describe = (value: Target) =>
    [tracks[value.track]?.room?.name, formatDateTime(locale, value.instant)]
      .filter(Boolean)
      .join(" · ");
  const clearDraft = () => {
    draft.current?.keyboard.destroy();
    draft.current = null;
    setActive(null);
  };
  useEffect(
    () => () => {
      stop.current?.();
      draft.current?.keyboard.destroy();
    },
    [],
  );
  useEffect(() => {
    if (save.state !== "idle" || !save.data || !pending.current) return;
    const { item, restore } = pending.current;
    pending.current = null;
    if (save.data.error) setFeedback({ key: item.id, error: save.data.error });
    announce(save.data.error ?? t("calendar.schedule.saved"));
    if (restore && document.activeElement === document.body) {
      document
        .querySelector<HTMLElement>(
          `[data-schedule-control="${CSS.escape(`${item.id}:${restore}`)}"]`,
        )
        ?.focus();
    }
  }, [save.state, save.data, t]);

  function commit(item: Item, mode: Mode, target: Target, keyboard = false) {
    const minutes = Math.round((target.instant - time(item, mode)) / 60_000);
    const roomId = tracks[target.track]?.room?.id;
    if (!minutes && roomId === item.booking?.roomId) return;
    if (mode === "resize" && target.instant <= +new Date(item.startsAt)) {
      const error = t("work.err.endsAfterStart");
      setFeedback({ key: item.id, error });
      announce(error);
      return;
    }
    const input: EventScheduleInput = {
      eventId: item.booking?.eventId ?? item.id,
      expectedStartsAt: new Date(item.booking?.eventStartsAt ?? item.startsAt).toISOString(),
      expectedEndsAt: new Date(item.booking?.eventEndsAt ?? item.endsAt).toISOString(),
      minutes,
      mode,
      booking:
        item.booking && roomId
          ? {
              id: item.id,
              fromRoomId: item.booking.roomId,
              roomId,
              expectedStartsAt: new Date(item.startsAt).toISOString(),
              expectedEndsAt: new Date(item.endsAt).toISOString(),
            }
          : undefined,
    };
    pending.current = { item, ...(keyboard && { restore: mode }) };
    setFeedback(null);
    void save.submit(input, { method: "post", encType: "application/json", action: "/calendar" });
  }

  function press(item: Item, mode: Mode, event: PointerEvent<HTMLElement>) {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      event.ctrlKey ||
      pending.current ||
      stop.current
    )
      return;
    const element = event.currentTarget;
    const lane = element.closest<HTMLElement>("[data-schedule-track]");
    const viewport = lane?.closest<HTMLElement>("[data-slot-orientation]");
    if (!lane || !viewport) return;
    const read = (track: number, node: HTMLElement, x: number, y: number) => {
      const slots = tracks[track]?.slots;
      if (!slots?.length) return null;
      const rect = node.getBoundingClientRect();
      const position = horizontal
        ? ((x - rect.left) * slots.length) / rect.width
        : (y - rect.top) / 48;
      const slot = slots.find((candidate) => candidate.row === Math.floor(position));
      return slot ? slot.instant + (position - slot.row) * hour : null;
    };
    const { clientX, clientY } = event;
    const origin = read(item.track, lane, clientX, clientY);
    if (origin === null) return;
    let preview: ReturnType<typeof bindDragPreview> | undefined;
    let label: HTMLSpanElement | undefined;
    const scroll = createAutoScroll({ ignore: () => preview?.el });
    const targetAt = (x: number, y: number) => {
      const node = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-schedule-track]");
      if (!node) return;
      const resizing = mode === "resize";
      const track = resizing ? item.track : Number(node.dataset.scheduleTrack);
      const instant = read(track, resizing ? lane : node, x, y);
      if (instant !== null)
        return {
          track,
          instant: time(item, mode) + Math.round((instant - origin) / quarter) * quarter,
        };
    };
    const cleanup = bindDrag(element, event.nativeEvent, {
      threshold: dragThreshold,
      cancelOnEscape: true,
      onStart: () => {
        clearDraft();
        setFeedback(null);
        preview = bindDragPreview(element.closest<HTMLElement>("[data-schedule-card]") ?? element, {
          x: clientX,
          y: clientY,
        });
        label = document.createElement("span");
        label.className =
          "bg-card shadow-surface-2 nums absolute top-0 right-0 max-w-56 truncate rounded-md px-1.5 py-0.5 text-xs";
        preview.el.append(label);
      },
      onMove: ({ x, y }) => {
        const target = targetAt(x, y);
        if (label)
          label.textContent = target
            ? [tracks[target.track]?.room?.name, formatTime(locale, target.instant)]
                .filter(Boolean)
                .join(" · ")
            : "";
        preview?.move(x, y);
        if (mode === "resize") {
          const bounds = viewport.getBoundingClientRect();
          scroll.update(
            horizontal
              ? x
              : (Math.max(0, bounds.left) + Math.min(window.innerWidth, bounds.right)) / 2,
            horizontal
              ? (Math.max(0, bounds.top) + Math.min(window.innerHeight, bounds.bottom)) / 2
              : y,
          );
        } else scroll.update(x, y);
      },
      onEnd: ({ clientX: x, clientY: y }, cancelled) => {
        stop.current = null;
        scroll.stop();
        preview?.remove();
        if (cancelled || !preview) return;
        const target = targetAt(x, y);
        if (target) commit(item, mode, target);
      },
    });
    stop.current = () => {
      cleanup();
      scroll.stop();
      preview?.remove();
    };
  }

  function activate(item: Item, mode: Mode) {
    if (pending.current) return;
    const current = draft.current;
    clearDraft();
    if (current?.item.id === item.id && current.mode === mode) {
      commit(current.item, mode, current.target, true);
      return;
    }
    const initial = time(item, mode);
    const value: Target = { track: item.track, instant: initial };
    const keyboard = keyboardMove({
      id,
      describe: () => describe(value),
      nudge: (dx, dy) => {
        const track = value.track + (horizontal ? dy : dx);
        const slots = tracks[track]?.slots;
        if (!slots || (mode === "resize" && track !== item.track)) return false;
        let instant = value.instant + (horizontal ? dx : dy) * quarter;
        if (!horizontal && track !== value.track) {
          const origin = tracks[value.track].slots.find(
            (slot) => instant >= slot.instant && instant < slot.instant + hour,
          );
          const next = slots.find((slot) => slot.row === origin?.row);
          if (!origin || !next) return false;
          instant += next.instant - origin.instant;
        }
        if (
          instant < (horizontal ? Math.min(initial, slots[0].instant) : slots[0].instant) ||
          instant > slots[slots.length - 1].instant + hour ||
          (mode === "resize" && instant <= +new Date(item.startsAt))
        )
          return false;
        Object.assign(value, { track, instant });
        setActive({ key: item.id, mode, text: describe(value) });
        return true;
      },
    });
    draft.current = { item, mode, target: value, keyboard };
    setFeedback(null);
    setActive({ key: item.id, mode, text: describe(value) });
    announce(t("calendar.schedule.keys"));
  }

  return {
    active,
    feedback,
    busy: save.state !== "idle",
    columns: tracks.length,
    horizontal,
    press,
    activate,
    cancel: clearDraft,
    draft,
  };
}

export function ScheduleCard({
  item,
  grid,
  resize = true,
  title,
  to,
  className,
  style,
  children,
}: {
  item?: Item;
  grid: ReturnType<typeof useCalendarSchedule>;
  resize?: boolean;
} & Pick<ComponentProps<typeof Link>, "title" | "to" | "className" | "style" | "children">) {
  const t = useT();
  const active = item && grid.active?.key === item.id ? grid.active : null;
  const error = item && grid.feedback?.key === item.id ? grid.feedback.error : null;
  const hint = useId();
  const note = useRef<HTMLParagraphElement>(null);
  const Grip = grid.horizontal ? GripVertical : GripHorizontal;
  useLayoutEffect(() => {
    const panel = note.current;
    const viewport = panel?.closest("[data-slot-orientation]");
    if (!panel || !viewport || !panel.parentElement) return;
    const bounds = viewport.getBoundingClientRect();
    const card = panel.parentElement.getBoundingClientRect();
    panel.toggleAttribute(
      "data-above",
      card.bottom + panel.offsetHeight > Math.min(window.innerHeight, bounds.bottom),
    );
    panel.toggleAttribute("data-align-end", card.left + panel.offsetWidth > bounds.right);
  }, [active, error]);
  return (
    <div
      data-schedule-card
      className={cn(className, "group isolate focus-within:z-20", (error || active) && "z-30")}
      style={style}
    >
      <Link
        to={to}
        title={title}
        draggable={item ? false : undefined}
        className={cn(
          "flex size-full min-w-0 flex-col gap-0.5 overflow-hidden rounded-[inherit] px-2 py-1",
          grid.horizontal && "justify-center gap-1",
          item && "touch-none cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={item ? (event) => grid.press(item, "move", event) : undefined}
        aria-describedby={error ? hint : undefined}
      >
        <span
          aria-hidden
          className="bg-tint group-hover:bg-tint-hover pointer-events-none absolute inset-0 -z-10 rounded-[inherit]"
        />
        {children}
      </Link>
      {item &&
        (resize ? (["move", "resize"] as const) : (["move"] as const)).map((mode) => {
          const moving = mode === "move";
          const Icon = moving ? Move : Grip;
          const label = item.booking
            ? t(moving ? "calendar.schedule.moveBooking" : "calendar.schedule.resizeBooking", {
                event: item.title,
                room: item.booking.roomName,
              })
            : t(moving ? "calendar.schedule.move" : "calendar.schedule.resize", {
                event: item.title,
              });
          return (
            <Button
              key={mode}
              type="button"
              data-schedule-control={`${item.id}:${mode}`}
              aria-label={label}
              aria-pressed={active?.mode === mode}
              aria-describedby={active || error ? hint : undefined}
              disabled={grid.busy}
              focusableWhenDisabled
              className={cn(
                "bg-card text-foreground pointer-events-none absolute flex touch-none items-center justify-center rounded opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
                grid.horizontal
                  ? moving
                    ? "top-0 left-0 size-6 cursor-grab"
                    : "right-0 bottom-0 h-6 w-3 cursor-ew-resize"
                  : moving
                    ? "top-0 right-0 size-6 cursor-grab"
                    : "right-0 bottom-0 h-3 w-7 cursor-ns-resize",
              )}
              onPointerDown={(event) => grid.press(item, mode, event)}
              onClick={() => grid.activate(item, mode)}
              onBlur={active?.mode === mode ? grid.cancel : undefined}
              onKeyDown={(event) => {
                const current = grid.draft.current;
                if (!current || current.item.id !== item.id || current.mode !== mode) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  grid.cancel();
                } else if (event.altKey && event.key.startsWith("Arrow")) {
                  current.keyboard.api.move.keydown(event.nativeEvent, "card");
                  event.preventDefault();
                }
              }}
            >
              <Icon aria-hidden className="size-3" />
            </Button>
          );
        })}
      {active || error ? (
        <p
          ref={note}
          id={hint}
          className={cn(
            "bg-card shadow-surface-3 absolute top-full z-40 w-max max-w-56 rounded-md px-2 py-1.5 text-xs data-[above]:top-auto data-[above]:bottom-full data-[align-end]:right-0 data-[align-end]:left-auto",
            !grid.horizontal && item && grid.columns > 1 && item.track >= grid.columns - 2
              ? "right-0"
              : "left-0",
            error && "text-destructive",
          )}
        >
          {error ?? (
            <>
              {active?.text}
              <br />
              {t("calendar.schedule.keys")}
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
