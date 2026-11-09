import * as React from "react";
import { useFetcher } from "react-router";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { LANES, TICKET_LANE_STATUS, type Lane } from "~/domains/tasks/tasks.lanes";
import { laneTitle } from "~/components/tasks/labels";
import { BoardColumn } from "./board-column";
import type { BoardCard } from "./task-card";
import { parseTicketDragId, type BoardTicket } from "./ticket-card";
import { computeDrop, finalLaneOrder, type DragOrigin } from "./drop";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * The `/board` client surface.
 *
 * **Local lane state is the render source while a drag is in flight.** The
 * board starts from `loaderData.lanes`, applies drops OPTIMISTICALLY, submits
 * the computed `{lane, afterId, beforeId}` through `useFetcher` (intent
 * `move`), and resyncs from `loaderData` on every revalidation — an SSE
 * `emitChange("task")` already triggers the refetch (`useLiveRefetch` in the
 * shell), so another user's move lands here too. On an error response the
 * local state is thrown away and the loader's truth is restored — the server
 * never lies about position, the client only ever guesses it.
 *
 * **Neighbour semantics** (`moveTask`'s contract): `afterId` = the card the
 * moved one goes AFTER; `beforeId` = the card it goes BEFORE. Dropping on a
 * card inserts before it; dropping on the lane's empty space appends.
 */
export type BoardLanes = Record<Lane, BoardCard[]>;
export type BoardTicketLanes = Record<Lane, BoardTicket[]>;

const EMPTY_TICKETS: BoardTicketLanes = {
  BACKLOG: [],
  IN_PROGRESS: [],
  IN_REVIEW: [],
  DONE: [],
  CANCELLED: [],
};

const isLane = (id: string): id is Lane => (LANES as readonly string[]).includes(id);

function laneOfCard(lanes: BoardLanes, id: string): Lane | undefined {
  return LANES.find((lane) => lanes[lane].some((t) => t.id === id));
}

function laneOfTicket(lanes: BoardTicketLanes, id: string): Lane | undefined {
  return LANES.find((lane) => lanes[lane].some((t) => t.id === id));
}

/** The lane a ticket ends in after a move to `lane` — append, tickets keep
 *  their view order inside a lane (no position to reorder). */
function moveTicketCard(lanes: BoardTicketLanes, ticketId: string, lane: Lane): BoardTicketLanes {
  const source = laneOfTicket(lanes, ticketId);
  if (!source || source === lane) return lanes;
  const card = lanes[source].find((t) => t.id === ticketId)!;
  return {
    ...lanes,
    [source]: lanes[source].filter((t) => t.id !== ticketId),
    [lane]: [...lanes[lane], card],
  };
}

function moveCard(lanes: BoardLanes, taskId: string, lane: Lane, index: number): BoardLanes {
  const source = laneOfCard(lanes, taskId);
  if (!source) return lanes;
  const card = lanes[source].find((t) => t.id === taskId)!;
  const without = { ...lanes, [source]: lanes[source].filter((t) => t.id !== taskId) };
  const target = [...without[lane]];
  target.splice(Math.min(index, target.length), 0, card);
  return { ...without, [lane]: target };
}

/** Rebuild one lane from a finished drop's final id order. */
function applyLaneOrder(lanes: BoardLanes, lane: Lane, ids: string[], taskId: string): BoardLanes {
  const all = new Map<string, BoardCard>();
  for (const l of LANES) for (const t of lanes[l]) all.set(t.id, t);
  const next = { ...lanes };
  for (const l of LANES) next[l] = lanes[l].filter((t) => t.id !== taskId);
  next[lane] = ids.map((id) => all.get(id)).filter((t): t is BoardCard => t !== undefined);
  return next;
}

export function TaskBoard({
  initialLanes,
  initialTickets = EMPTY_TICKETS,
  // The DndContext id seeds dnd-kit's `DndDescribedBy-N`/`DndLiveRegion-N` ids;
  // the module-level counter differs between SSR and the client, so without a
  // stable id every /board load hydration-mismatches and React discards the
  // server tree. Distinct per mounted board — one per page today.
  dndId = "task-board",
  // Where drops POST. The board route is the default; an embedded board (the
  // project views) points its fetcher at `/board` so the same move
  // contract answers there.
  submitAction,
}: {
  initialLanes: BoardLanes;
  initialTickets?: BoardTicketLanes;
  dndId?: string;
  submitAction?: string;
}) {
  const locale = useLocale();
  const t = useT();
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [lanes, setLanes] = React.useState<BoardLanes>(initialLanes);
  const [ticketLanes, setTicketLanes] = React.useState<BoardTicketLanes>(initialTickets);
  const [error, setError] = React.useState<string | null>(null);
  const [showCancelled, setShowCancelled] = React.useState(false);
  const [resolutionTicket, setResolutionTicket] = React.useState<BoardTicket | null>(null);
  const resolutionDialog = React.useRef<HTMLDialogElement>(null);
  const busy = fetcher.state !== "idle";

  React.useEffect(() => {
    if (resolutionTicket) resolutionDialog.current?.showModal();
  }, [resolutionTicket]);

  // The drag's origin (lane + id order at pick-up). onDragOver already moves
  // the card between lanes in local state, so `onDragEnd` must compare the drop
  // against THIS — not against the already-mutated lanes — to tell a real move
  // from a no-op. Non-null also marks "a drag is in flight". `ticketOriginRef`
  // plays the same role for ticket drags (which have no order, only a lane).
  const originRef = React.useRef<DragOrigin | null>(null);
  const ticketOriginRef = React.useRef<{ id: string; lane: Lane } | null>(null);
  const latestLanesRef = React.useRef(initialLanes);
  const latestTicketsRef = React.useRef(initialTickets);

  const resync = () => {
    setLanes(latestLanesRef.current);
    setTicketLanes(latestTicketsRef.current);
  };

  // The loader is the truth: any revalidation (own POST finishing, SSE from
  // another session) replaces the optimistic state wholesale — but NEVER
  // mid-drag; the latest loader data is kept aside and applied when the drag
  // ends or cancels.
  React.useEffect(() => {
    latestLanesRef.current = initialLanes;
    latestTicketsRef.current = initialTickets;
    if (!originRef.current && !ticketOriginRef.current) {
      setLanes(initialLanes);
      setTicketLanes(initialTickets);
    }
  }, [initialLanes, initialTickets]);

  // A refused move (stale board, validation) reverts the optimistic drop and
  // says why — the card visually snaps back.
  React.useEffect(() => {
    if (fetcher.data?.error) {
      setLanes(latestLanesRef.current);
      setTicketLanes(latestTicketsRef.current);
      setError(fetcher.data.error);
    } else if (fetcher.data?.ok) {
      setError(null);
      resolutionDialog.current?.close();
    }
  }, [fetcher.data]);

  const sensors = useSensors(
    // An activation distance keeps plain clicks free for the title link and
    // keeps text selection sane — a card is only "picked up" after 4px.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart({ active }: DragStartEvent) {
    setError(null);
    const ticketId = parseTicketDragId(String(active.id));
    if (ticketId) {
      const lane = laneOfTicket(ticketLanes, ticketId);
      ticketOriginRef.current = lane ? { id: ticketId, lane } : null;
      return;
    }
    const lane = laneOfCard(lanes, String(active.id));
    originRef.current = lane ? { lane, ids: lanes[lane].map((t) => t.id) } : null;
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (!over || parseTicketDragId(String(active.id))) return; // tickets never preview-move
    const overId = String(over.id);
    const targetLane = isLane(overId) ? overId : laneOfCard(lanes, overId);
    if (!targetLane) return;
    const source = laneOfCard(lanes, String(active.id));
    if (!source || source === targetLane) return;
    // Cross-lane: move the card over in local state so the column it is
    // hovering re-renders it immediately (dnd-kit's cross-container recipe).
    const index = isLane(overId)
      ? lanes[targetLane].length
      : lanes[targetLane].findIndex((t) => t.id === overId);
    setLanes((current) =>
      moveCard(
        current,
        String(active.id),
        targetLane,
        index < 0 ? lanes[targetLane].length : index,
      ),
    );
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    // A ticket drag: lane change only — a drop inside its own lane is ignored
    // client-side (tickets have no position to reorder).
    const ticketDrag = ticketOriginRef.current;
    ticketOriginRef.current = null;
    if (ticketDrag) {
      const overId = over ? String(over.id) : null;
      const overTicketId = overId ? parseTicketDragId(overId) : null;
      const targetLane: Lane | undefined = overId
        ? isLane(overId)
          ? overId
          : overTicketId
            ? laneOfTicket(ticketLanes, overTicketId)
            : laneOfCard(lanes, overId)
        : undefined;
      if (!targetLane || targetLane === ticketDrag.lane) {
        resync();
        return;
      }
      const ticket = ticketLanes[ticketDrag.lane].find((ticket) => ticket.id === ticketDrag.id);
      if (!ticket || busy || resolutionTicket) {
        resync();
        return;
      }
      const action = ticket.allowedActions.find(
        (action) => action.target === TICKET_LANE_STATUS[targetLane],
      );
      if (!action) {
        setError(
          t("tickets.board.invalidDrop", {
            lane: laneTitle(locale, targetLane),
            actions: ticket.allowedActions.map((action) => t(action.labelKey)).join(", "),
          }),
        );
        resync();
        return;
      }
      if (action.requiredFields.includes("resolution")) {
        setResolutionTicket(ticket);
        resync();
        return;
      }
      setTicketLanes((current) => moveTicketCard(current, ticketDrag.id, targetLane));
      const body = new FormData();
      body.set("_action", "move-ticket");
      body.set("ticketId", ticketDrag.id);
      body.set("lane", targetLane);
      void fetcher.submit(body, { method: "post", action: submitAction });
      return;
    }

    const origin = originRef.current;
    originRef.current = null;
    if (!over || !origin) {
      resync(); // dropped nowhere — back to the truth
      return;
    }
    const taskId = String(active.id);
    const overId = String(over.id);
    const overTicketId = parseTicketDragId(overId);
    const overIsLane = isLane(overId);
    const targetLane: Lane | undefined = overIsLane
      ? overId
      : overTicketId
        ? laneOfTicket(ticketLanes, overTicketId)
        : laneOfCard(lanes, overId);
    if (!targetLane) {
      resync();
      return;
    }

    // The lane's final order is computed against the ORIGIN, not the mutated
    // local state: onDragOver may already have preview-moved the card into the
    // target lane, so `laneOfCard` alone can no longer tell a cross-lane drop
    // from a same-lane shuffle.
    const finalIds = finalLaneOrder(
      lanes[targetLane].map((t) => t.id),
      taskId,
      overId,
      overIsLane,
    );
    const drop = computeDrop(origin, finalIds, targetLane, taskId);
    if (!drop) {
      // Back where it started — resync in case the loader moved under the drag.
      resync();
      return;
    }

    setLanes((current) => applyLaneOrder(current, targetLane, finalIds, taskId));
    const body = new FormData();
    body.set("_action", "move");
    body.set("taskId", taskId);
    body.set("lane", drop.lane);
    if (drop.afterId) body.set("afterId", drop.afterId);
    if (drop.beforeId) body.set("beforeId", drop.beforeId);
    void fetcher.submit(body, { method: "post", action: submitAction });
  }

  function onDragCancel() {
    originRef.current = null;
    ticketOriginRef.current = null;
    resync();
  }

  const visibleLanes = LANES.filter((lane) => lane !== "CANCELLED" || showCancelled);

  return (
    <div className="flex flex-col gap-3">
      <dialog
        ref={resolutionDialog}
        aria-labelledby="board-resolution-title"
        aria-describedby="board-resolution-help"
        className="bg-card text-foreground shadow-surface-5 fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100%-2rem))] overflow-y-auto rounded-xl p-6 backdrop:bg-(--scrim)"
        onClose={() => {
          setResolutionTicket(null);
          setError(null);
        }}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        {resolutionTicket ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              void fetcher.submit(new FormData(event.currentTarget), {
                method: "post",
                action: submitAction,
              });
            }}
          >
            <h2 id="board-resolution-title" className="text-lg font-semibold break-words">
              {t("tickets.board.resolveTitle", { title: resolutionTicket.title })}
            </h2>
            <p id="board-resolution-help" className="text-muted-foreground text-sm">
              {t("tickets.detail.resolutionHelp")}
            </p>
            <input type="hidden" name="_action" value="move-ticket" />
            <input type="hidden" name="ticketId" value={resolutionTicket.id} />
            <input type="hidden" name="lane" value="DONE" />
            <Label htmlFor="board-resolution">{t("tickets.detail.resolution")}</Label>
            <Textarea
              id="board-resolution"
              name="resolution"
              required
              rows={3}
              aria-describedby={
                error ? "board-resolution-help board-resolution-error" : "board-resolution-help"
              }
              aria-invalid={Boolean(error)}
            />
            {error ? (
              <p id="board-resolution-error" role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="tertiary"
                disabled={busy}
                onClick={() => resolutionDialog.current?.close()}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t("common.saving") : t("tickets.detail.resolve")}
              </Button>
            </div>
          </form>
        ) : null}
      </dialog>
      {error && !resolutionTicket ? (
        <p
          role="alert"
          className="text-destructive bg-card shadow-surface-2 rounded-lg px-3 py-2 text-sm"
        >
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="tertiary"
          size="compact"
          aria-pressed={showCancelled}
          onClick={() => setShowCancelled((v) => !v)}
        >
          {showCancelled
            ? t("board.toggle.hideCancelled")
            : t("board.toggle.showCancelled", { count: lanes.CANCELLED.length })}
        </Button>
      </div>
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements: {
            onDragStart: () => t("board.dnd.start"),
            onDragOver: ({ over }) =>
              over
                ? isLane(String(over.id))
                  ? t("board.dnd.overLane", { lane: laneTitle(locale, over.id as Lane) })
                  : t("board.dnd.overCard")
                : t("board.dnd.outside"),
            onDragEnd: () => t("board.dnd.end"),
            onDragCancel: () => t("board.dnd.cancel"),
          },
          screenReaderInstructions: {
            draggable: t("board.dnd.instructions"),
          },
        }}
      >
        <div className="flex gap-3 overflow-x-auto pb-2">
          {visibleLanes.map((lane) => (
            <BoardColumn
              key={lane}
              lane={lane}
              title={laneTitle(locale, lane)}
              tasks={lanes[lane]}
              tickets={ticketLanes[lane]}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
