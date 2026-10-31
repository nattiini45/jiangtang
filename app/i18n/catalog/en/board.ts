import type { boardDe } from "../de/board";

export const boardEn = {
  "board.meta.list": "Board · Jiangtang",

  "board.list.title": "Board",
  "board.list.subtitle":
    "Tasks as cards — dragging moves column and position (keyboard too: space to pick up, arrows to move).",
  "board.list.filterProject": "Filter by project",
  "board.list.projectAll": "All projects",
  "board.list.filterAssignee": "Filter by person",
  "board.list.assigneeAll": "All people",
  "board.list.assigneeMe": "Assigned to me",
  "board.list.filterSubmit": "Filter",
  "board.list.workMode": "Work mode (with tickets)",
  "board.list.workModeActive": " — active",

  "board.toggle.showCancelled": "Show cancelled ({count})",
  "board.toggle.hideCancelled": "Hide cancelled",

  "board.column.entries": "{count} entries",
  "board.column.tickets": "Tickets",

  "board.card.gripAria": "Card “{title}” — press space to pick up, arrows to move",

  "board.ticket.gripAria": "Ticket “{title}” — drag to change the column",
  "board.ticket.iconAria": "Ticket",
  "board.ticket.priority.1": "High",
  "board.ticket.priority.2": "Medium",
  "board.ticket.priority.3": "Low",

  "board.dnd.start": "Card picked up. Use the arrow keys to move, space to drop.",
  "board.dnd.overLane": "Card over {lane}.",
  "board.dnd.overCard": "Card over another card.",
  "board.dnd.outside": "Card outside any column.",
  "board.dnd.end": "Card dropped.",
  "board.dnd.cancel": "Move cancelled.",
  "board.dnd.instructions":
    "Press space or enter to pick up. Use the arrow keys to move, space to drop, escape to cancel.",
} satisfies Record<keyof typeof boardDe, string>;
