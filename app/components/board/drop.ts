import { arrayMove } from "@dnd-kit/sortable";
import type { Lane } from "~/domains/tasks/tasks.lanes";

/**
 * Pure drop computation for `/board`. The board records where a drag
 * STARTED — `origin` — because `onDragOver` has already moved the card into
 * the hovered lane in local state by the time `onDragEnd` runs; comparing the
 * drop against the current state would call every cross-lane drop a no-op.
 */
export interface DragOrigin {
  lane: Lane;
  /** The source lane's id order at `onDragStart`, card included. */
  ids: string[];
}

/**
 * The lane order the drop produces — the standard dnd-kit sortable recipe:
 * `arrayMove(ids, oldIndex, newIndex)` on the lane the card ends in, where
 * `newIndex` is the hovered card's index (the card takes its slot; the hovered
 * card fills the gap — that is exactly what the sortable animation settles
 * into) or the end of the lane when dropping on the column's empty space.
 * `laneIds` includes the dragged card when `onDragOver` already preview-moved
 * it; the fallback path inserts it for drags that never produced an onDragOver.
 */
export function finalLaneOrder(
  laneIds: string[],
  taskId: string,
  overId: string,
  overIsLane: boolean,
): string[] {
  const oldIndex = laneIds.indexOf(taskId);
  if (oldIndex >= 0) {
    const newIndex = overIsLane ? laneIds.length : laneIds.indexOf(overId);
    return arrayMove(laneIds, oldIndex, newIndex < 0 ? laneIds.length : newIndex);
  }
  const ids = [...laneIds];
  // An id that is not a task in this lane (a ticket card is a droppable in work
  // mode) behaves like the lane itself: append, never insert at index 0.
  const overIndex = overIsLane ? -1 : ids.indexOf(overId);
  ids.splice(overIndex < 0 ? ids.length : overIndex, 0, taskId);
  return ids;
}

/**
 * The `moveTask` payload for a finished drag, or `null` when the drop is a
 * no-op. A drop is a no-op ONLY when the card lands back in its origin lane
 * between exactly the neighbours it started between — cross-lane drops always
 * submit, even when `onDragOver` already moved the card into the lane locally.
 */
export function computeDrop(
  origin: DragOrigin,
  finalLaneIds: string[],
  lane: Lane,
  taskId: string,
): { lane: Lane; afterId?: string; beforeId?: string } | null {
  const index = finalLaneIds.indexOf(taskId);
  if (index < 0) return null;
  const afterId = index > 0 ? finalLaneIds[index - 1] : undefined;
  const beforeId = index < finalLaneIds.length - 1 ? finalLaneIds[index + 1] : undefined;
  if (lane === origin.lane) {
    const at = origin.ids.indexOf(taskId);
    if (at >= 0) {
      const originAfter = at > 0 ? origin.ids[at - 1] : undefined;
      const originBefore = at < origin.ids.length - 1 ? origin.ids[at + 1] : undefined;
      if (originAfter === afterId && originBefore === beforeId) return null;
    }
  }
  return { lane, afterId, beforeId };
}
