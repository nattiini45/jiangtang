import type { errorsWorkDe } from "../de/errors-work";

/** English twins of the work-domain error messages; `satisfies` keeps the key sets identical. */
export const errorsWorkEn = {
  // ── Shared field validation (zod schemas) ──────────────────────────────────
  "work.err.titleRequired": "Title is required.",
  "work.err.titleTooLong": "Title is too long.",
  "work.err.nameRequired": "Name is required.",
  "work.err.noteTooLong": "Note is too long.",
  "work.err.invalidDate": "Invalid date.",
  "work.err.csvDayFormat": "Invalid date — expected YYYY-MM-DD or DD.MM.YYYY.",
  "work.err.dueBeforeStart": "Due date cannot be before the start date.",
  "work.err.minutesInteger": "Minutes must be a whole number.",
  "work.err.minutesNegative": "Minutes cannot be negative.",
  "work.err.dateFormat": "Date must be in YYYY-MM-DD format.",
  "work.err.timeFormat": "Time must be in HH:MM format.",
  "work.err.endsAfterStart": "End must be after the start.",
  "work.err.colorFormat": "Color must be in #RRGGBB format.",
  "work.err.invalidClientId": "Invalid ID (cuid format expected).",
  "work.err.csv.statusUnknown":
    "Unknown status — expected the enum value or a label (German/English).",
  "work.err.csv.priorityUnknown":
    "Unknown priority — expected the enum value or a label (German/English).",
  "work.err.csv.assigneeUnknown": 'assignees: "{key}" is not a known initials or email.',
  "work.err.csv.projectUnknown": 'project: "{slug}" is not a known project slug.',

  // ── Not-found / unknown references (domain throws) ─────────────────────────
  "work.err.task.notFound": "Task not found.",
  "work.err.task.unknown": "Unknown task.",
  "work.err.task.locationUnknown": "Unknown location.",
  "work.err.project.notFound": "Project not found.",
  "work.err.project.unknown": "Unknown project.",
  "work.err.note.notFound": "Note not found.",
  "work.err.note.conflict": "Someone else saved this note while you were editing.",
  "work.err.note.authorRequired": "Note requires a signed-in author.",
  "work.err.noteImport.authorRequired": "Note import requires a signed-in author.",
  "work.err.note.alreadyArchived": "The note is already archived.",
  "work.err.note.notArchived": "The note is not archived.",
  "work.err.note.locationUnknown": "Unknown location.",
  "work.err.ticket.notFound": "Ticket not found.",
  "work.err.event.notFound": "Event not found.",
  "work.err.event.roomBookingNotFound": "Room booking not found.",
  "work.err.event.equipmentNotFound": "Equipment not found.",
  "work.err.event.allocationNotFound": "Allocation not found.",
  "work.err.event.serviceWindowNotFound": "Service window not found.",
  "work.err.timeEntry.notFound": "Time entry not found.",
  "work.err.unknownUser": "Unknown user.",
  "work.err.time.unknownUser": "Unknown user.",

  // ── Task rules ─────────────────────────────────────────────────────────────
  "work.err.task.selfParent": "A task cannot be its own parent task.",
  "work.err.task.parentInSubtree":
    '"{parentTitle}" is in the subtree of "{title}". A task cannot be moved into its own subtask.',
  "work.err.task.statusAlready": "The task already has this status.",
  "work.err.task.betweenItself": "A task cannot be placed between itself.",
  "work.err.task.besideItself": "A task cannot be placed next to itself.",
  "work.err.task.notInLane": '"{title}" is not in this lane.',
  "work.err.laneChanged": "The lane changed — please reload.",
  "work.err.task.deleteWithSubtasks.one":
    '"{title}" still has {count} subtask. Move it first — a task with subtasks is not deleted.',
  "work.err.task.deleteWithSubtasks.other":
    '"{title}" still has {count} subtasks. Move them first — a task with subtasks is not deleted.',
  "work.err.task.alreadyLinkedToTicket": '"{title}" is already linked to a ticket.',
  "work.err.task.notLinkedToTicket": '"{title}" is not linked to any ticket.',
  "work.err.ticket.alreadyLinkedToTask": '"{title}" is already linked to a task.',
  "work.err.task.selfBlocker": "A task cannot block itself.",
  "work.err.task.blockerExists": "This block already exists.",
  "work.err.task.blockerMissing": "This block does not exist.",
  "work.err.task.cycle":
    '"{taskTitle}" already indirectly blocks "{blockerTitle}" — this dependency would create a cycle.',

  // ── Project rules ──────────────────────────────────────────────────────────
  "work.err.project.selfParent": "A project cannot be its own parent project.",
  "work.err.project.parentInSubtree":
    '"{parentName}" is in the subtree of "{name}". A project cannot be moved into its own subproject.',
  "work.err.project.statusAlready": "The project already has this status.",
  "work.err.project.deleteWithSubprojects.one":
    '"{name}" still has {count} subproject. Move it first — a project with subprojects is not deleted.',
  "work.err.project.deleteWithSubprojects.other":
    '"{name}" still has {count} subprojects. Move them first — a project with subprojects is not deleted.',
  "work.err.project.subprojectsSinceCheck":
    '"{name}" gained subprojects since the check and cannot be deleted.',

  // ── Ticket rules ───────────────────────────────────────────────────────────
  "work.err.ticket.priorityRange": "Priority 1–3.",
  "work.err.ticket.resolutionRequiredResolved": "Resolution is required when already resolved.",
  "work.err.ticket.resolvedBeforeOccurred": "Resolution time is before the occurrence time.",
  "work.err.ticket.resolutionRequired": "Resolution is required.",
  "work.err.ticket.invalidTransition": "Invalid status change from {from} to {to}.",
  "work.err.ticket.noReviewLane": "Tickets have no review lane.",

  // ── Event rules ────────────────────────────────────────────────────────────
  "work.err.event.dateTimeRequired": "Date and time are required.",
  "work.err.event.roomRequired": "Room is required.",
  "work.err.event.equipmentRequired": "Equipment is required.",
  "work.err.event.cancelled": "A cancelled event can no longer be changed.",
  "work.err.event.roomAlreadyBooked": "The room is already booked in this time range.",
  "work.err.event.equipmentAlreadyAllocated":
    "This equipment is already allocated in this time range.",
  "work.err.event.onlyPooled": "Only mobile (pooled) equipment can be allocated.",
  "work.err.event.retiredEquipment": "Retired equipment cannot be allocated.",

  // ── Time rules ─────────────────────────────────────────────────────────────
  "work.err.time.onlyOwnEntries": "Only your own time entries can be edited.",
  "work.err.time.timerAlreadyRunning": "A timer is already running — stop it first.",
  "work.err.time.timerRequired": "Timer requires a signed-in user.",
  "work.err.time.noTimerRunning": "No timer is running.",
  "work.err.time.entryAuthorRequired": "Time entry requires a signed-in user.",

  // ── CSV / workspace / markdown import ──────────────────────────────────────
  "work.err.import.row": "Row {line}: {errors}",
  "work.err.import.taskLabel": 'Task {index} ("{title}")',
  "work.err.import.projectLabel": 'Project {index} ("{slug}")',
  "work.err.import.noteLabel": 'Note {index} ("{title}")',
  "work.err.import.duplicateId": "duplicate ID in the file.",
  "work.err.import.duplicateSlug": "duplicate slug in the file.",
  "work.err.import.projectSlugUnknown": 'projectSlug "{slug}" is not a known project.',
  "work.err.import.parentSlugUnknown": 'parentSlug "{slug}" is not a known project.',
  "work.err.import.parentTaskIdUnknown": 'parentTaskId "{id}" is unknown.',
  "work.err.import.taskIdUnknown": 'Task "{id}" is unknown.',
  "work.err.import.blockerUnknown": 'blocker "{blockerId}" (for "{taskId}") is unknown.',
  "work.err.import.assigneeUnknown": 'assignee "{email}" is not a known user.',
  "work.err.import.leadEmailUnknown": 'leadEmail "{email}" is not a known user.',
  "work.err.import.slugTaken": 'slug "{slug}" already belongs to another project.',
  "work.err.import.selfParentTask": "cannot be its own parent task.",
  "work.err.import.selfParentProject": "cannot be its own parent project.",
  "work.err.import.locationIdUnknown": 'locationId "{id}" is unknown.',
  "work.err.import.fileEmpty": '"{file}": file is empty.',
  "work.err.import.fileUnreadable": "File is not readable.",
  "work.err.import.fileError": '"{file}": {message}',
  "work.err.import.fileProjectSlugUnknown": '"{file}": "{slug}" is not a known project slug.',
  "work.err.import.fileLocationUnknown": '"{file}": "{id}" is not a known location.',
} satisfies Record<keyof typeof errorsWorkDe, string>;
