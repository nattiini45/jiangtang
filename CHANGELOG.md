# Changelog

All notable changes to Jiangtang are recorded here in Keep a Changelog form.
This file changes only in release-prep pull requests, not in individual feature
pull requests. At release-prep time, compile the changelog lines from the merged
pull requests into the version's section, grouped under Added, Changed, Fixed or
Removed as appropriate. Every release section includes an **Upgrade notes** block
with any operator action, or an explicit statement that none is required.

## [0.2.0] - 2026-11-15

### Added

- **Account:** Show MCP connection details, a safe agent setup prompt and Windows-compatible client configuration on the personal access token page.
- **Rooms:** Rooms now surface known problems, operating notes, check history and installed-device support details.
- **Inventory:** Add model port templates, individual device ports and network fields for all equipment categories, including MCP support.
- **Inventory:** Devices can document and trace two-ended port connections through the desktop interface and MCP.
- **Inventory:** Add data-backed device kinds and function groups, with automatic legacy-category initialization and backfill, without changing the interface.
- **Inventory:** Show device kinds in inventory, forms, search and MCP, and group installed room equipment by function.
- **Fields:** Added audited custom-field definitions, device-kind applicability and choice-option management through MCP.
- **Fields:** Added typed, audited custom room/device values and MCP value round trips.
- **Structure:** Admins can shape device kinds and function groups through the Structure screen and MCP, with audited moves and live search updates.
- **Structure:** Admins can selectively install device kinds for their team from the built-in bilingual library, through Structure or MCP.
- **Fields:** Room and device forms can edit the team's properties, which are shown on device, room and hall pages.
- **Lists:** Administrators can choose shared room and device list columns, including the team's properties, and rooms can be filtered by device kind.
- **Structure:** Admins can manage team-defined fields and options on screen, preserving them when device kinds are combined.
- **Calendar:** Added a top-level calendar for dated work and room/equipment dates; Events is now a separate list.
- **Inventory:** Models hold shared data-sheet values, and projectors receive protected, bilingual library properties automatically.
- **Catalog:** Add the shipped Epson projector catalog, model picking and automatic data/manual/port linking with corrections and unlinking.
- **Inventory:** Added automatic library properties for every shipped device kind, editable ranges and compatible legacy-device value copying.
- **Rooms:** Added room function states with device evidence and phone fault reporting.
- **Rooms:** Added a cross-room list of known function faults with location/function filters, age sorting and direct links to room evidence.
- **Rooms:** Rooms retain known fixes by function, offer them during fault reporting and explicitly move earlier notes into audited repairs.
- **Functions:** Added selected-room rounds, phone function checks, time-limited green confirmations and audited admin-set function states.
- **Rooms:** Added data-defined room types, per-room expected functions and non-fault gaps, with carrier-aware round checklists and legacy feature compatibility.
- **Home:** Added a shared operational home with five data-filled blocks and per-person, cross-device show/highlight/hide and ordering preferences.
- **Inventory:** Devices now show compatible parts and available stock; part pages list compatible models/devices and support an audited take-one action.
- **Readings:** Added dated device readings, atomic replacement counter resets, and shared due states on devices, home and the full due list.
- **Plans:** Add opt-in recurring room-function rounds and electrical inspections, with sourced defaults, actual-date scheduling and calendar/home due work.
- **Tables:** List columns can be resized, fitted and reset, with browser-persisted widths and balanced defaults.

### Changed

- **Config:** Centralize installation configuration reads without changing defaults or behavior.
- **Release:** Use GitHub-generated release provenance and explain image-source verification and safe publishing retries.
- **Fields:** Device fields may reuse names across non-overlapping kinds without making any record show duplicate names.
- **Inventory:** Library properties can be hidden, renamed and reordered, while conditional properties stay out of forms and pages until they apply.

### Fixed

- **Release:** Fix release provenance generation and catch incomplete predicates in dry-run tests.
- **Lists:** Fixed desktop list filters missing optional text and visible translated labels.
- **Fields:** Custom-field name conflicts explain which field holds the name and how to recover.

### Upgrade notes

- The normal update runs the new migrations automatically before the app starts. Back up the database and uploads first, as always; a code rollback does not undo a migration.
- No new required environment variable. Two new optional ones: `FUNCTION_CONFIRMATION_DAYS` (how long a green function confirmation stays valid, default 200) and `READING_DUE_MARGIN_PERCENT` (the due-soon margin for readings, 0–100, default 10).
- Compatible parts: existing stock items are never linked to a part model by name or SKU. To show available stock for a part, assign the stock item to its part model on the stock page.
- The phone Capture shortcut moves to `/m/quick-entry`; old room capture links redirect and queued offline submissions remain accepted, so no action is required.
- MCP `update_room` remains a full replacement of editable fields: callers that retain `knownIssues` and `lastCheckedAt` must include them, because omission clears them.

## [0.1.0] - 2026-11-12

### Added

- **Rooms and locations:** a places tree of campuses, buildings, rooms and storage locations, with room dashboards that list equipment and open tickets.
- **Room QR codes:** each room has a code that opens quick entry for that room, so a problem can be logged on site.
- **Equipment and models:** equipment units linked to models, rooms and stock items, with status, fixed or pooled mobility, and a QR code on each page.
- **Stock:** stock items with serial and SKU uniqueness, quantities, vendors, locations and warranties; admins are told in the app before a warranty expires.
- **CSV import:** importers for equipment, stock, tasks and room data.
- **Events and bookings:** room bookings and equipment allocations that the database refuses to double-book, with a conflict check before saving.
- **Calendar views:** week, month, day, rooms and list views, filtered by room, equipment and status, with the date and filters kept in the URL.
- **Calendar feeds:** a token-protected iCal feed for subscribing from a calendar app, enabled by `ICAL_FEED_TOKEN`.
- **CalDAV push:** optional one-way push of events to Nextcloud or Sciebo, enabled by the `CALDAV_*` variables and testable from the admin pages.
- **Tasks and projects:** statuses, priorities, labels, estimates and a dependency graph that refuses cycles, with a keyboard-operable kanban board, and Gantt and burndown views.
- **Tickets:** room and equipment tickets with types, priorities and assignees, and quick entry from a room.
- **Notes:** a Markdown editor with autosave, pins, tags, archive, and export and import as `.md` files.
- **Search and Ask:** lexical search over the workspace; optional vector search, reranking and cited answers when an OpenAI-compatible endpoint is configured.
- **Time tracking:** a weekly timesheet with a running timer and a capacity view per person; personal entries are private, and access to them is granted per person and audited.
- **Audit history:** every change is written to an append-only audit history, shown per record and in the activity feed.
- **Notifications:** an in-app inbox for task assignments, tasks due soon, booking conflicts and expiring warranties, updated live. Nothing is sent by e-mail.
- **Phone app:** an installable web app at `/m` that captures tickets, tasks and notes offline and sends each one exactly once.
- **Accounts:** invitation-only sign-in, with one-time invitation links that admins pass on by hand; optional two-factor sign-in with an authenticator app and backup codes, mandatory for admins with `REQUIRE_ADMIN_TWO_FACTOR=true`.
- **MCP server:** an authenticated `/mcp` endpoint for external MCP clients, using personal access tokens that are read-only or read-write.
- **Uploads:** JPEG, PNG and WebP up to 15 MB, checked by their contents, stripped of EXIF and GPS data, and stored encrypted with thumbnails.
- **Workspace export and import:** a versioned JSON format for projects, tasks and notes, applied all-or-nothing; the export is for admins.
- **Admin users and invitations:** admins create and deactivate people, reset passwords, erase a person's data, create invitation links, see each invitation's state, and revoke or reissue one, with an audit trail.
- **Admin Overview:** installation health and detected problems: database migrations, file storage, calendar push, search index, admins without two-factor sign-in, and first-admin variables still set.
- **Admin search index and About:** search and AI status with a calendar connection test, and the running version and commit with the presence (never the value) of each environment variable.
- **Operator commands:** `admin:reset-password` and `admin:reset-2fa` reset an admin's password or two-factor sign-in from the command line, and both are audited.
- **Production stack:** Docker Compose with Caddy for TLS, a migration job that finishes before the app starts, and optional WAL-G backups of PostgreSQL and uploads to S3.
- **Released images:** each release publishes `linux/amd64` images tagged with the version and its minor line, with a software bill of materials and build provenance.
- **Languages:** English and German, with `DEFAULT_LOCALE` choosing the installation language.

### Upgrade notes

This is the first release, so there is nothing to upgrade from. An installation that followed `main` before this release needs no extra step: its normal update (`git pull --ff-only` and `docker compose up -d --build`) runs the migrations automatically before the app starts. No new variable is required. Take a backup before updating, as always.
