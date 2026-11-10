# Jiangtang — feature page

Jiangtang (讲堂, "lecture hall") is a self-hosted, all-in-one workspace for an AV or facilities
team. One deployment covers the whole day: plan the work, book the rooms, log what broke, and
see what happened — with an append-only audit history behind every change.

The interface is English and German; `DEFAULT_LOCALE` picks the installation language and each
visitor can switch with the language control. Times are stored as UTC and displayed in
`Europe/Berlin`.

## Rooms, locations and places

- A places tree (campus → building → room, plus free-form storage locations) with a manage mode
  for campuses and buildings inside the rooms view.
- Room dashboards with installed equipment, open tickets and a QR code that deep-links to quick
  entry for that room — scan it on site to log an entry.
- Room status, capabilities and CSV import.

## Equipment, models and stock

- Equipment units linked to models, rooms and stock items, with status and mobility (fixed vs.
  pooled).
- Stock items with serial/SKU uniqueness, quantities, vendors, locations, warranties — and a
  daily sweep that notifies admins in-app before a warranty expires.
- CSV importers for equipment and stock; QR code on each equipment page.

## Events and bookings

- Events with a room-booking and equipment-allocation model enforced by a database-level
  `EXCLUDE` constraint: **double-booking is impossible**, not just discouraged.
- Pre-save conflict checks in the UI, plus an inbox notification to the affected organizer when a
  conflict is rejected.
- Token-gated iCal feed for team calendars.

## Tasks, projects and board

- Tasks with statuses, priorities, labels, per-assignee estimates, a dependency graph that refuses
  cycles, and ticket ⇄ task links.
- A kanban board with pointer and keyboard moves, and project views (board, Gantt, burndown).
- Assignment changes notify the assignee in the in-app inbox.

## Tickets and quick entry

- Tickets with types, priorities and assignees, fed by a quick-entry form (room first, then
  equipment) that also works offline: the mobile PWA (`/m`) queues captures and replays each
  exactly once.
- Photo attachments: JPEG/PNG/WebP, magic-byte checked, re-encoded with EXIF/GPS stripped,
  stored encrypted, with thumbnails.

## Notes and search

- Notes with a Markdown editor, autosave, pins, tags, archive and `.md` export/import.
- `/search` combines trigram lexical retrieval with optional vector search and reranking over an
  operator-configured, OpenAI-compatible endpoint; `Ask` streams cited answers when a generation
  provider is configured. Without any provider, search stays lexical and `Ask` answers with
  cited results — nothing external is required to run.

## Activity, timesheet and notifications

- An append-only activity feed with per-entity history.
- A weekly timesheet with a running timer and interval-union totals, plus a capacity heatmap
  (demand vs. configured weekly capacity per person).
- An in-app notification center: assignment, due-soon, booking-conflict and warranty-expiry
  notifications, with live updates over the realtime channel.

## Mobile PWA

- The `/m` surface: capture (offline queue), rooms, locations, stock, events, projects, notes,
  timesheet timer, tickets, board, search and the inbox — precached for offline use, with
  install shortcuts from the manifest.

## Accounts and privacy

- Invitation-only accounts (the public sign-up endpoint is disabled); admin-managed users.
- GDPR tooling: pseudonymization ("erase") with audit trail, data inventory in
  [docs/GDPR.md](GDPR.md).
- Signed-in pages are purged from the service-worker cache on sign-out.

## Operations

- See [DEPLOY.md](DEPLOY.md) for the Compose production stack and [BACKUP.md](BACKUP.md) for
  WAL-G backups.
