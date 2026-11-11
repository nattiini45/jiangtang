# Changelog

All notable changes to Jiangtang are recorded here in Keep a Changelog form.
This file changes only in release-prep pull requests, not in individual feature
pull requests. At release-prep time, compile the changelog lines from the merged
pull requests into the version's section, grouped under Added, Changed, Fixed or
Removed as appropriate. Every release section includes an **Upgrade notes** block
with any operator action, or an explicit statement that none is required.

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
- **Tasks and projects:** statuses, priorities, labels, estimates and a dependency graph that refuses cycles, with a keyboard-operable kanban board and board, Gantt and burndown views.
- **Tickets:** room and equipment tickets with types, priorities and assignees, and quick entry from a room.
- **Notes:** a Markdown editor with autosave, pins, tags, archive, and export and import as `.md` files.
- **Search and Ask:** lexical search over the workspace; optional vector search, reranking and cited answers when an OpenAI-compatible endpoint is configured.
- **Time tracking:** a weekly timesheet with a running timer and a capacity view per person; personal entries are private, and access to them is granted per person and audited.
- **Notifications:** an in-app inbox for task assignments, tasks due soon, booking conflicts and expiring warranties, updated live. Nothing is sent by e-mail.
- **Phone app:** an installable web app at `/m` that captures tickets, tasks and notes offline and sends each one exactly once.
- **Accounts:** invitation-only sign-in, with one-time invitation links that admins pass on by hand; optional two-factor sign-in with an authenticator app and backup codes, mandatory for admins with `REQUIRE_ADMIN_TWO_FACTOR=true`.
- **MCP server:** an authenticated `/mcp` endpoint for external MCP clients, using personal access tokens that are read-only or read-write.
- **Uploads:** JPEG, PNG and WebP up to 15 MB, checked by their contents, stripped of EXIF and GPS data, and stored encrypted with thumbnails.
- **Workspace export and import:** a versioned JSON format for projects, tasks and notes, applied all-or-nothing; the export is for admins.
- **Admin users:** admins create and deactivate people, reset passwords, and erase a person's data, with an audit trail.
- **Admin Overview:** installation health and detected problems: database migrations, file storage, calendar push, search index, admins without two-factor sign-in, and first-admin variables still set.
- **Admin search index and About:** search and AI status with a calendar connection test, and the running version and commit with the presence (never the value) of each environment variable.
- **Operator commands:** `admin:reset-password` and `admin:reset-2fa` reset an admin's password or two-factor sign-in from the command line, and both are audited.
- **Production stack:** Docker Compose with Caddy for TLS, a migration job that finishes before the app starts, and optional WAL-G backups of PostgreSQL and uploads to S3.
- **Released images:** each release publishes `linux/amd64` images tagged with the version and its minor line, with a software bill of materials and build provenance.
- **Languages:** English and German, with `DEFAULT_LOCALE` choosing the installation language.

### Upgrade notes

This is the first release, so there is nothing to upgrade from. An installation that followed `main` before this release needs no extra step: its normal update (`git pull --ff-only` and `docker compose up -d --build`) runs the migrations automatically before the app starts. No new variable is required. Take a backup before updating, as always.
