# Jiangtang — features

Jiangtang (讲堂, "lecture hall") is a self-hosted workspace for an AV or facilities team. One
installation covers rooms and equipment, stock, event bookings, tickets, projects, tasks and notes,
with an append-only audit history behind every change.

This page describes what the application does today. Where a feature stays off until the operator
configures it, the text says so.

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

## Calendar

- `/events` opens a week view (Monday first). Month, day, rooms and list views are one click away;
  the date, view and filters are part of the URL, so a view can be bookmarked or shared.
- The rooms view shows each room's free and booked hours for a day. Choosing a free hour starts a
  new booking for that room and time; in the other views, an empty slot starts a new event.
- Filter by room, equipment and status, and optionally show task due dates next to the events.
- Subscribe from a calendar app with the token-gated iCal feed at `/calendar/<token>/ics`. It is
  off until `ICAL_FEED_TOKEN` is set; admins see the ready-made link on the calendar page. It
  lists events from the past and the coming year, with an embedded `Europe/Berlin` time zone.
- Optionally push events to a CalDAV server such as Nextcloud or Sciebo (`CALDAV_URL`,
  `CALDAV_USERNAME`, `CALDAV_PASSWORD`). The push is one way: creating or editing an event writes
  it to one calendar and cancelling it removes it, nothing is read back, and edits made in the
  calendar are overwritten. It is off while those variables are empty. Admins can test the
  connection and see the push status on `/admin/index`. Setup is in
  [DEPLOY.md](DEPLOY.md#calendar-push-to-sciebo-or-nextcloud).

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

## Activity and time tracking

- An append-only activity feed with per-entity history.
- A weekly timesheet: start and stop a timer on a task, or add an entry by hand. Overlapping
  entries count once in the day and week totals.
- A capacity heatmap (demand vs. configured weekly capacity per person).

## Notifications

- An in-app inbox for four kinds of notification: assigned to a task, task due soon, booking
  conflict, and warranty about to expire. The unread count updates live over the realtime channel.
- Notifications stay in the app. Jiangtang does not send e-mail.

## Phone app

- An installable web app at `/m`: add it to the home screen from the browser; there is no app
  store listing and no native wrapper. See [MOBILE-PWA.md](MOBILE-PWA.md).
- Capture tickets, tasks and notes from the phone. Without a connection, entries wait in an
  offline queue on the device and are sent exactly once when it reconnects.
- Also on the phone: rooms (with a day's bookings), locations, stock, events, projects, notes, the
  timesheet timer, tickets, the board, search and the notification inbox.

## Accounts and privacy

- Invitation-only accounts (the public sign-up endpoint is disabled); admin-managed users. Admins
  pass invitation and password-reset links on by hand, because there is no e-mail delivery.
- Two-factor sign-in, optional per user: a TOTP code from an authenticator app, with one-time
  backup codes. Users set it up, turn it off and create new backup codes on `/account`.
  `REQUIRE_ADMIN_TWO_FACTOR=true` makes it mandatory for admins; an admin without it is held on the
  account page until they enrol. An admin who lost both authenticator and backup codes is reset
  with the operator command in [DEPLOY.md](DEPLOY.md#6-first-login).
- GDPR tooling: pseudonymization ("erase") with audit trail, data inventory in
  [docs/GDPR.md](GDPR.md).
- Signed-in pages are purged from the service-worker cache on sign-out.

## MCP server

- `/mcp` is a Streamable HTTP endpoint for external MCP clients such as Cursor or Claude Code.
  Jiangtang has no built-in agent; the client and its model do the work.
- Access uses personal access tokens. Each user creates and revokes their own on `/account`, as
  read-only or read-write. A token acts as its owner and never exceeds the owner's role; revoking
  or deactivating the account ends access.
- It offers tools for rooms, equipment, stock, events and bookings, tickets, projects, tasks,
  notes, time entries, notifications, activity and search, plus read-only resources and planning
  prompts. Details, client setup and safety limits are in [MCP.md](MCP.md).

## Operations

- See [DEPLOY.md](DEPLOY.md) for the Compose production stack, including how to run it behind an
  existing reverse proxy, and [BACKUP.md](BACKUP.md) for WAL-G backups.
- Releases follow SemVer 0.y.z; the upgrade and image policy is in the
  [README](../README.md#releases-and-upgrades).
