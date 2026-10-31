import type { statusDe } from "../de/status";

export const statusEn = {
  "status.room.ALL_GOOD": "All good",
  "status.room.PROVISIONAL": "Provisional",
  "status.room.MAINTENANCE_NEEDED": "Maintenance needed",
  "status.room.TECH_DEFECT": "Technical fault",
  "status.room.OUT_OF_SERVICE": "Out of service",

  "status.equipment.OPERATIONAL": "Operational",
  "status.equipment.FAULTY": "Faulty",
  "status.equipment.MAINTENANCE": "Maintenance",
  "status.equipment.RETIRED": "Retired",

  "status.ticket.OPEN": "Open",
  "status.ticket.IN_PROGRESS": "In progress",
  "status.ticket.RESOLVED": "Resolved",
  "status.ticket.CANCELLED": "Cancelled",

  "status.event.PLANNED": "Planned",
  "status.event.CONFIRMED": "Confirmed",
  "status.event.IN_PROGRESS": "Running",
  "status.event.DONE": "Completed",
  "status.event.CANCELLED": "Cancelled",

  "status.project.REQUESTED": "Requested",
  "status.project.CONFIRMED": "Confirmed",
  "status.project.AWAITING_FEEDBACK": "Awaiting feedback",
  "status.project.CONSULTATION_SCHEDULED": "Consultation scheduled",
  "status.project.COMPLETED": "Completed",
  "status.project.FOLLOW_UP_REQUIRED": "Follow-up required",
  "status.project.REJECTED": "Rejected",
  "status.project.CANCELLED": "Cancelled",

  "status.task.BACKLOG": "Backlog",
  "status.task.TODO": "To do",
  "status.task.IN_PROGRESS": "In progress",
  "status.task.IN_REVIEW": "In review",
  "status.task.BLOCKED": "Blocked",
  "status.task.DONE": "Done",
  "status.task.CANCELLED": "Cancelled",

  "status.taskPriority.URGENT": "Urgent",
  "status.taskPriority.HIGH": "High",
  "status.taskPriority.MEDIUM": "Medium",
  "status.taskPriority.LOW": "Low",
  "status.taskPriority.LOWEST": "Lowest",

  "status.stock.AVAILABLE": "Available",
  "status.stock.REQUESTED": "Requested",
  "status.stock.AWAITING_CONFIRMATION": "Awaiting confirmation",
  "status.stock.ON_LOAN": "On loan",
  "status.stock.RESERVED_FOR_EVENT": "Reserved for event",
} satisfies Record<keyof typeof statusDe, string>;
