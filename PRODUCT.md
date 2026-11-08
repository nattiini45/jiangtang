# Jiangtang product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Jiangtang serves a university AV and facilities team. Members manage planned work, reported
faults, rooms, equipment and events; administrators also manage accounts and the installation.
The application has `ADMIN` and `MEMBER` roles, not a separate lecturer/customer ticket portal.

## Product Purpose

One self-hosted workspace brings rooms and equipment, stock, event bookings, tickets, projects,
tasks, notes and search together with an append-only audit history. The team's replacement goal
is to consolidate work currently spread across Taskmeister, Notion, Znuny and Outlook/Sciebo
calendars. This is a product goal, not a claim of feature parity or completed migration.

## Operating Context

- One installation serves one team. Multi-tenancy is specified, not implemented.
- The desktop route tree renders at `/`. The separate mobile web PWA at `/m` supports on-site
  capture, an offline replay queue, search and mobile lists; its board is read-only.
- English and German are supported. German is the intended installation language for the team:
  set `DEFAULT_LOCALE=de`. The upstream configuration fallback and checked-in examples remain
  English. A visitor's locale cookie, then `Accept-Language`, override the installation language.
  User-entered content is never translated.
- Instants are stored in UTC and displayed in `Europe/Berlin`; there is no per-user time zone.
- Sciebo/Nextcloud integration publishes events one way through optional CalDAV. It is not a
  two-way calendar replacement. A token-gated iCal feed is also available.
- The opt-in `/welcome` landing page exists but is parked for the team's current work. It is not
  the application entry point and is outside the design baseline's scope.

## Capabilities and Constraints

- Tasks have assignments, status, priority, labels, dates, dependencies and project views; tickets
  can link to tasks and to rooms or equipment. Notes use Markdown and support import/export.
- Rooms are bookable spaces in a campus/building hierarchy. Locations are a separate tree for
  storage and where things or work happen; they are not interchangeable room records.
- Database exclusion constraints prevent overlapping room bookings and equipment allocations.
  Mutations and their append-only audit rows commit together.
- Accounts are invitation-only. Optional search AI, CalDAV and error reporting stay optional;
  basic application startup and lexical search do not require an external service.
- Taskmeister-specific import, task/ticket conversations, recurrence and email-based ticket
  workflows are not established replacement capabilities. Do not promise them from the presence
  of task, ticket or calendar screens.

## Evidence on Hand

Implemented product behavior is documented in [README.md](README.md),
[FEATURES.md](docs/FEATURES.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md) and the source route trees
under `app/routes/`. Roles and entities are defined in `prisma/schema.prisma`; locale behavior
is in `app/i18n/`; synthetic demonstration content is in `scripts/seed/`.

The university audience, replacement-tool goal, intended German installation and parked welcome
page are the maintainer's design-baseline brief, recorded here as product direction. They are not
claims of a deployed university service, an existing user base or successful migration.

Surface-specific design modes are recorded in `.impeccable/surfaces/`: Operate for the app and
Read for documentation. Visual implementation belongs in [DESIGN.md](DESIGN.md), not here.

## Product Principles

- Keep related operational work in one workspace without claiming parity with every replaced tool.
- Preserve booking correctness and auditable changes rather than relying on client-side checks.
- Support German and English, with mobile capture alongside the desktop workspace.
- Keep a single-team installation and optional integrations usable without a hosted service.
