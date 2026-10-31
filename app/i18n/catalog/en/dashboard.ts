import type { dashboardDe } from "../de/dashboard";

export const dashboardEn = {
  "dashboard.meta": "Overview · Jiangtang",
  "dashboard.subtitle": "Your workday in Jiangtang — due, blocked, assigned.",
  "dashboard.quickLinks": "Quick links",
  "dashboard.quick.entry": "Log an entry",

  "dashboard.empty.title": "The workspace is still empty.",
  "dashboard.empty.body":
    "Create a task, a project or a note — or load the demo workspace to look around.",
  "dashboard.empty.newTask": "Create task",
  "dashboard.empty.newProject": "Create project",
  "dashboard.empty.newNote": "Create note",
  "dashboard.demo.load": "Load demo workspace",
  "dashboard.demo.loading": "Loading demo workspace…",
  "dashboard.demo.loaded": "Demo workspace loaded — {created} new, {skipped} already present.",

  "dashboard.due.title": "Due today",
  "dashboard.due.allTasks": "All tasks →",
  "dashboard.due.overdue": "{count} overdue",
  "dashboard.due.none": "Nothing due today.",
  "dashboard.due.more": "+{count} more",

  "dashboard.blocked.title": "Blocked",
  "dashboard.blocked.link": "Blocked tasks →",
  "dashboard.blocked.none": "Nothing blocked.",
  "dashboard.blocked.waitingOn": "waiting on: {titles}",

  "dashboard.mine.title": "My work",
  "dashboard.mine.link": "All my tasks →",
  "dashboard.mine.summary": "Tasks: {tasks} · Tickets: {tickets} · Σ {effort}",
  "dashboard.mine.none": "Nothing is assigned to you.",

  "dashboard.recent.title": "Recently changed",
  "dashboard.recent.link": "All activity →",

  "dashboard.storage.title": "Storage & index",
  "dashboard.storage.attachments": "Attachments",
  "dashboard.storage.totalSize": "Total size",
  "dashboard.storage.backend": "Backend",
  "dashboard.storage.index": "Index",
  "dashboard.storage.indexLink": "Search index →",

  "activity.meta": "Activity · Jiangtang",
  "activity.subtitle":
    "Everything that happens in the workspace — tasks, tickets, notes and more, in chronological order.",
  "activity.filterByPerson": "Filter by person",
  "activity.allPeople": "All people",
  "activity.filterSubmit": "Filter",
  "activity.empty.title": "No activity for these filters.",
  "activity.empty.hint": "Adjust the time range or type filter.",
  "activity.grouped": "{count} entries grouped",
  "activity.loadOlder": "Load older",

  "quickEntry.meta": "Quick entry · Jiangtang",
  "quickEntry.subtitle": "Log an entry — still open or already resolved.",
  "quickEntry.submit": "Log entry",
  "quickEntry.submitting": "Logging…",

  "importHub.meta": "Import / Export · Jiangtang",
  "importHub.subtitle":
    "Every import path in one place — plus the versioned JSON export of the whole workspace.",
  "importHub.rooms.title": "Rooms (CSV)",
  "importHub.rooms.hint": "Room CSV: number, building, capacity, equipment.",
  "importHub.equipment.title": "Equipment (CSV)",
  "importHub.equipment.hint": "Equipment models and instances with serial numbers and location.",
  "importHub.stock.title": "Stock (CSV)",
  "importHub.stock.hint": "Stock items: SKU, model, condition, storage location.",
  "importHub.tasks.title": "Tasks (CSV)",
  "importHub.tasks.hint":
    "title,status,priority,start,due,estimate,labels,assignees,project — atomic per file.",
  "importHub.notes.title": "Notes (Markdown)",
  "importHub.notes.hint": "Folder of .md files; frontmatter tags are carried over.",
  "importHub.export.title": "Export workspace",
  "importHub.export.body":
    "Projects, tasks (including assignments and blockers) and notes as a versioned JSON file — {format} v1.",
  "importHub.export.download": "Download JSON export",
  "importHub.import.title": "Import workspace",
  "importHub.import.body":
    "Read in a {format} file — atomic: unknown references or a blocking cycle reject the whole import.",
  "importHub.import.fileAria": "Choose workspace JSON file",
  "importHub.import.submitting": "Importing…",
  "importHub.import.done":
    "Imported: {projects} projects, {tasks} tasks, {notes} notes, {edges} dependencies.",
} satisfies Record<keyof typeof dashboardDe, string>;
