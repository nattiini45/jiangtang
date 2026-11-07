# Jiangtang — all-angles audit, gap analysis and executable plan

Date: 2026-11-07 · Branch: `fix/orbit-gap-defects` · Status: **report only — nothing executed**
Method: full read of `README.md`, `docs/ARCHITECTURE.md`, `docs/conventions.md`, `AGENTS.md`, the route tree (88 route modules), the Prisma schema (32 models, 17 enums), the layout/shell components, the PWA stack (`public/sw.js`, `app/lib/pwa/*`, manifest), the domain layer (17 domains), boot modules (9), the production stack (Compose/Caddy/WAL-G), the test suites (104 Vitest files, 13 Playwright specs) and the build output (`build/client` ≈ 2.1 MB, entry ≈ 184 KB).

---

## 1. What the project is

**Jiangtang (讲堂, "lecture hall")** is a self-hosted, single-workspace web app for an **AV / facilities team**: rooms and equipment, stock, event bookings with a database-enforced no-double-booking rule, tickets, projects/tasks, notes, hybrid search + optional "Ask", an append-only audit feed, timesheet/capacity, a mobile PWA for on-site capture, and invitation-only accounts with GDPR erasure. UI in English and German; instants stored UTC, displayed Europe/Berlin.

Positioning today: **a serious internal tool, not a marketed product.** There is deliberately no hosted service, no public demo, no telemetry, no marketing site in the repo — the README is the marketing. "Best all-in-one service of its kind" therefore has two very different readings (see §12, Q1).

## 2. Surface inventory

### 2.1 Desktop (`_desktop` layout at `/`, `AppShell` sidebar + header)
Sidebar: 20 entries in 4 flat groups (no nested menus anywhere):

| Group | Entries |
| --- | --- |
| Work | Overview `/`, Board, Tasks, Timesheet, Capacity, Projects, Notes, Activity, Search |
| Rooms & equipment | Rooms, Locations, Campuses, Inventory, Stock, Frequencies |
| Operations | Tickets, Events |
| Data & admin | Import/Export, Analytics*, Users*, Search index* (*adminOnly) |

Header: ⌘K command palette (nav verbs + actions, derived from the same `nav.ts` array), running-timer chip with stop, language switcher, density toggle, theme toggle, logout. `quick-entry` (ticket from a room/equipment context) is **not in the nav** — reachable only via palette verb and room deep links.

Feature routes (folders under `app/routes/_desktop.*`): dashboard; board (kanban, dnd-kit + keyboard); tasks list/new/detail/import (lanes, dependencies DAG, labels, per-assignee estimates, ticket⇄task links); timesheet (weekly grid, running timer, interval-union totals); capacity (demand-vs-capacity heatmap, 6 ISO weeks); projects list/new/detail/edit (board, Gantt, burndown over the same tasks); notes list/new/detail/import (Markdown autosave, pin/archive/tags, .md export, folder import); rooms list/new/detail(+dashboard)/edit/clone/import; locations CRUD tree; campuses+buildings CRUD; inventory (equipment instances) + models (catalog) + stock (serial/SKU-unique, warranties, CSV import) + imports; tickets list/new/detail (types, priorities, born-resolved, attachments); events list (list + month calendar views, iCal subscribe)/new/detail (multi-room bookings, pooled equipment allocations, setup/standby/teardown service windows, conflict pre-check API); activity feed (cursor-paginated, grouped, per-entity history); search (hybrid lexical+trigram+optional vector, Ask box with streaming citations); import/export (CSV, Markdown, versioned JSON workspace transfer); admin: users (invite links, deactivate, erase/pseudonymize), search index reconcile.

### 2.2 Mobile PWA (`/m`, own `MobileShell`, bottom tab bar)
Routes (13): capture home `/m` (photo + quick task/note capture, offline queue), rooms list + room detail (installed gear, open tickets, "new entry" deep link), tasks list/new/detail, tickets list/detail, read-only board, search, new note, stock list, locations list, `/m/offline`. Bottom nav: **Rooms / Tasks / Capture / Tickets / More**; "More" is a bottom sheet containing only: new task, new note, board, search, language, logout, "desktop version" link. **Not reachable on mobile: events, projects, notes list, timesheet/timer, activity, capacity, inventory detail/models, frequencies, campuses, admin, import.**
PWA mechanics: manifest scoped to `/m/` (standalone, portrait, icons 192/512); hand-rolled `sw.js` scoped `/m/`, NetworkFirst for navigations/data, cache-first immutable assets, precache shell + offline page, sign-in purges shell caches; owner-bound IndexedDB offline queue with exactly-once replay via `clientId` and a 403 auth wall; queue badge in header; offline page with bounded retries and inline reload script.

### 2.3 Public / machine routes
`login`, `logout`, `accept-invite.$token`, `healthz`, `calendar.$token.ics` (token iCal feed with VTIMEZONE), `export.workspace.json`, `notes.$id.export`, `attachments.upload` / `attachments.$key` (session-gated, magic-byte check, sharp re-encode with EXIF/GPS strip, AES-256-GCM at rest, 400px thumbnail), `api.search`, `api.ask` (streaming), `api.events.check-conflict`, `prefs.locale`, `$.tsx` 404.

### 2.4 Ops surface
Docker Compose: postgres (custom image with pgvector + WAL-G), one-shot migrate + `verify-invariants.sql`, app, Caddy (TLS, security headers, 20MB body cap, **no compression** to protect SSE), backup job, profile-gated restore, alerting sidecar. Background jobs in-process: calendar outbox drain (CalDAV optional), search indexer (1-min reconcile + realtime debounce), audit retention, warranty sweep. Sentry/GlitchTip optional.

## 3. Architecture dissection

### 3.1 Stack and shape
One TypeScript app: React Router v7 framework mode on Vite behind a small Express server (`server.ts`); React 19; Tailwind v4 + a hand-rolled shadcn-style primitive set (`app/components/ui/`, 13 primitives — notably **no dialog/dropdown-menu/popover primitives**, sheets are hand-built); Prisma 7 (Rust-free, adapter-pg) into PostgreSQL 18 (btree_gist, pgvector, pg_trgm); Better Auth; sharp; typed in-house i18n catalogs (27 areas × en/de, parity-tested); pg NOTIFY → SSE realtime; optional OpenAI-compatible AI providers; pnpm 10.26.2, Node 22.12+/24.

Scale: ≈ 64k LOC in `app/` (excl. generated Prisma client), 88 route modules (~11k lines), largest: `tasks.$id` 495, `timesheet` 435, dashboard 414, `projects.$slug` 372, `tickets.$id` 363.

### 3.2 Data model (32 models)
Families: places (`Campus→Building→Room` **and** a separate self-referencing `Location` tree), equipment (`EquipmentModel` catalog + `Equipment` instances with mobility/spare links), stock (`InventoryItem` + `Vendor`), tickets, events (`Event`, `EventRoomBooking`, `EquipmentAllocation`, `ServiceWindow`), work (`Project`, `Task`, `TaskAssignees`, `TaskDependency` DAG, `TimeEntry`), notes, people (Better Auth + role/initials/isActive), attachments, append-only `ActivityLog`, `CalendarOutbox`, search (`Chunk`, `SearchIndexJob`), and a DB view `workitem` unioning tasks+tickets under one lane vocabulary.

### 3.3 Seams and invariants (the strong part)
- Boot modules (`*.boot.server.ts`, 9 of them) instead of editing `server.ts`; contract in `app/server/boot.ts`.
- Domain layer `app/domains/<area>/{queries,mutations,schema}`; routes never touch Prisma; `scripts/guards.sh` bans raw `db.$transaction` in domains and direct `@prisma/client` imports.
- All mutations through `txWithAudit`; `ActivityLog` append-only enforced by an `ENABLE ALWAYS` trigger; `ops/postgres/verify-invariants.sql` runs post-migrate and blocks startup.
- No-double-booking as GiST `EXCLUDE` on generated `during` ranges (`EventRoomBooking`, `EquipmentAllocation`); `insertOrConflict` → 409. Unique SKU/serial. One running timer per user (partial unique index). Positive intervals CHECK.
- Migrations: append-only 7-file baseline; hand-written SQL (EXCLUDE, triggers, view, generated columns) lives inside migration files; shadow DB for diffs; `db push` banned.
- Every loader/action self-guards (`requireUser`/`requireRole`) because single-fetch `.data` requests bypass layouts; enforced by `test/routes/route-auth-guard.test.ts` with a PUBLIC allowlist.
- Realtime: `emitChange` NOTIFY after commit → one pg listener → per-session SSE at `/api/realtime` with `Last-Event-ID` ring buffer; clients refetch (events are a hint, not truth).
- Auth: invitation-only (public sign-up disabled), Better Auth email+password, per-email/per-IP failed-login throttle (in-memory, single process — documented), bootstrap admin via env only while no active admin exists, GDPR erasure pseudonymizes. `sanitizeNext` on redirects.
- Storage behind a `StorageProvider` seam (fs + AES-256-GCM shipped; S3-pluggable); iCal/CalDAV behind publisher seam with transactional outbox + backoff.
- Tests: 104 Vitest files against an isolated `_test` DB (created, migrated, seeded; dev DB untouched), 13 Playwright specs incl. axe a11y sweep, keyboard flow, mobile offline, PWA sign-out cache, i18n sweep; migration-baseline and schema-guard tests; doc-link rot check.

### 3.4 Assessment
This is an unusually disciplined codebase: invariants live in the DB, the audit trail is tamper-evident, optional integrations are genuinely optional, and the test net is broad for the size. The architecture is **not** the weak point. The weak points are product surface decisions (§5–§9).

## 4. Feature-for-feature inventory

| Area | What exists | Notable gaps |
| --- | --- | --- |
| Tasks | list/detail/new/import, kanban (pointer+keyboard), lanes, labels, dependencies (cycle-refusing DAG), per-assignee estimates, ticket⇄task links, due summary, blocked list | no comments/discussion; no reminders/notifications on due dates; no saved views/filters persisted; no subtasks (dependencies only) |
| Projects | list/new/detail/edit, board + Gantt + burndown over shared tasks, nested projects | no project-level docs beyond notes link; no milestones |
| Board | dnd-kit sortable, fractional `position` (Decimal), keyboard moves, per-project/assignee filter | — |
| Timesheet / capacity | weekly grid, one running timer per user (DB-enforced), interval-union totals, demand-vs-capacity heatmap per assignee × 6 weeks | timer only start/stop; no manual interval edit UI? (verify); no per-user timezone |
| Notes | Markdown editor autosave, pin/archive/tags, .md export, folder import, project/location attach | no backlinks/graph, no sharing |
| Rooms | campus→building→room, capabilities (projector/mic/recording…), status, renewal window, external links (booking/manual/tour), tips, room dashboard (gear, open tickets, bookings), clone, CSV import, Notion idempotency key | no QR code per room; no per-room day/week agenda view separate from events calendar? (room dashboard covers bookings — verify) |
| Locations | generic self-tree (site…vehicle) for stock/tasks/notes | **overlaps conceptually with Rooms/Campuses** (see §6) |
| Inventory | equipment models + instances (mobility fixed/pooled, spare/substitute, per-type attrs), stock items (unique SKU/serial, qty, warranty, vendor), CSV importers, warranty sweep job, frequency-clash board | no ad-hoc checkout/check-in outside events; no QR/label printing; no maintenance schedules beyond ServiceWindow on events |
| Events | multi-room bookings + pooled equipment allocations (EXCLUDE-constrained), service windows (setup/standby/teardown), status, list + month calendar, conflict pre-check API, iCal feed (token) + CalDAV outbox | **no recurring events** (no RRULE in the model); no attendee management; no event templates |
| Tickets | types (incident/request/repair), statuses, priority, born-resolved, room/equipment/event links, reporter/assignees, attachments, task link, history | no comments; no SLA/aging alerts (analytics only); no public customer portal (n/a internal) |
| Search / Ask | trigram + lexeme (de/en) + optional pgvector arm, RRF fusion, optional rerank, Ask with streaming citations, indexer reconcile, admin reconcile verb | needs provider for semantic; `vector(1024)` frozen |
| Activity | append-only feed, grouped, per-entity history, retention + prune functions | read-only by design (correct) |
| Auth / admin | invite-only, roles ADMIN/MEMBER, throttle, erase/pseudonymize (GDPR), user mgmt, search-index admin, demo workspace loader | no 2FA, no SSO/OIDC, no API tokens/webhooks for integrations (only iCal token + export) |
| Import/export | CSV (tasks, stock, rooms), Markdown folder import, versioned JSON workspace transfer (projects/tasks/notes, all-or-nothing) | — |
| Uploads | JPEG/PNG/WebP ≤15MB, magic-byte check, EXIF/GPS stripped via sharp, AES-256-GCM at rest, thumbnail, session-gated serving | S3 provider not shipped (seam exists) |
| Mobile PWA | see §2.2 — capture-first, offline queue exactly-once, NetworkFirst SW, sign-out cache purge | see §9 — many desktop areas unreachable |
| i18n | en/de typed catalogs, parity test, cookie→Accept-Language→DEFAULT_LOCALE, Berlin formatting | only 2 languages; Europe/Berlin hardcoded (no per-user TZ) |
| Realtime | NOTIFY→SSE, per-session streams, resume buffer, refetch-on-change | no push notifications |

## 5. Missing architecture / features (candidates for "best all-in-one")

Ranked by value for an AV/facilities team, cost ascending:

1. **In-app notification center + reminders** (task due, ticket assigned, booking conflict, warranty expiry). Today: SSE refetch only; the audit feed is the closest thing. No web push on the PWA.
2. **Mobile parity**: events (today/week + create booking), projects, notes list, timesheet timer, stock detail, attachments — currently only via the "desktop version" link (§9).
3. **QR codes on rooms/equipment** (scan → room dashboard / create ticket / view gear) — the natural mobile-desktop bridge for on-site AV work; deep links already exist, only the QR rendering is missing.
4. **Recurring events** (RRULE) — weekly team meetings, standing service windows; currently impossible without manual copies.
5. **Comments/discussion on tasks & tickets** — the audit log records mutations but humans can't talk on an item.
6. **Ad-hoc equipment checkout/check-in** (not event-bound) — pooled gear loans between events.
7. **Per-user timezone** (currently hardcoded Europe/Berlin display) — matters the moment a team is not all in Berlin.
8. **Auth hardening for wider adoption**: 2FA and/or SSO (OIDC) via Better Auth; API tokens + outbound webhooks for integrations.
9. **PWA completeness**: manifest screenshots/shortcuts, install prompt, share target, web push, badge counts.
10. **Marketing surface** (only if the goal is external adoption): public landing/docs site, screenshots, hosted demo — explicitly out of scope today ("No hosted service").

## 6. Overcomplication / duplication findings

1. **Two overlapping "place" models**: `Campus→Building→Room` (bookable, AV-capability rooms) vs the generic `Location` tree (site/building/room/storage/rack/vehicle) used by stock/tasks/notes. The nav exposes three separate entries (Rooms, Locations, Campuses). For a new user "what is the difference between a Room and a Location?" is a real question. Either merge (locations as the tree, rooms as bookable nodes on it) or sharpen the IA (e.g. one "Places" section with tabs) — decision needed (§12, Q4).
2. **Inventory split across three URLs** (`/inventory`, `/inventory/models`, `/inventory/stock`) with two top-level nav entries (Inventory, Stock). Tabs inside one section would do.
3. **"Data & admin" group mislabels member-accessible Import/Export** — `/import` uses `requireUser` (not `requireRole(ADMIN)`) but sits in the admin group and is visible to MEMBERs. Either make it admin-only or rename the group ("Data").
4. **Frequencies** (radio-frequency clash board) is a niche feature occupying a top-level nav entry; candidate to move under Inventory as a tab or into admin.
5. **20 nav entries** — many are list pages of the same family. Flat is good (no nested menus), but the count itself is cognitive load; §10 proposes a consolidation to ~12 without hiding anything behind submenus.
6. **`quick-entry` is invisible in the nav** — the fastest "report a problem in this room" flow is palette-only. Should be a primary action (header "+" / room page button — room pages already deep-link it).
7. Smaller: `workitem` DB view + dual task⇄ticket relations are well-documented and fine; in-memory login throttle is a documented single-process limitation; `vector(1024)` is frozen for the DB's life (documented). None of these need changing now.

## 7. Design & presentation — is it marketing-ready?

What's strong: a real, coherent design system ("Fluid Functionalism") — token-driven light/dark themes, 8-step surface+shadow ladder, density steps, Inter Variable with optical sizing (weight changes don't shift width), frozen WCAG-AA-measured status palette, fluid hover/active-pill nav with layout animations, reduced-motion support, 16px touch inputs on coarse pointers, axe-swept in e2e. It reads as one authored product, not a template. 48 KB of CSS total.

What's not marketing-ready (if "marketing" means external adoption): there is **no public surface at all** — login is a bare form, the manifest is minimal (description "AV-Workspace", no screenshots, no shortcuts, portrait-locked), and the repo has no landing page, screenshots, or demo. The README/docs are excellent *operator* docs but there is no *buyer* story (feature page, comparison, "why self-hosted"). If the goal is a successful self-hosted product, that marketing layer lives outside this repo today.

In-product presentation gaps: empty states exist (good) + admin demo-workspace loader (good); but there's no guided first-run onboarding beyond that, no contextual help, and the two-place-model confusion (§6.1) will hit every new team.

## 8. Performance assessment

- SSR on; per-route code splitting (dozens of small chunks; entry.client 184 KB; largest lazy chunk chart-card 344 KB); immutable 1y caching for hashed assets; non-hashed static 1h. Total client build ≈ 2.1 MB across chunks — fine for an internal tool.
- **Gap: zero compression.** Caddy has no `encode` block (deliberate: buffering breaks SSE). That also disables gzip/zstd for JS/CSS/HTML. Fix is narrow: compress only `/assets/*` (immutable, never SSE) and leave the app uncompressed. Cheap, real win.
- Images: sharp re-encode + 400px thumbnails + encrypted at rest; served session-gated. Good.
- Loader data: no cache headers; SSE-driven refetch means live-but-chatty. Acceptable; could add `Cache-Control: no-store` explicitness.
- DB: indexed appropriately (status/type/occurredAt/startAt, trigram + HNSW on Chunk); EXCLUDE constraints use GiST. The 1-minute indexer reconcile plus event-driven debounce is fine.
- Dev-experience perf: `unstable_optimizeDeps` seeded to avoid mid-test rebundling — thoughtful.
- Verdict: performance is adequate for the internal-tool positioning; the compression gap and PWA shell weight are the only concrete items.

## 9. PWA assessment — is everything reachable, uncomplicated?

Mechanics are genuinely good (NetworkFirst so stale bookings never show, sign-out cache purge, owner-bound exactly-once offline queue with honest auth-wall handling, offline page with bounded retries, queue badge). Reachability is the weak part:

- Only **4 tabs + a More sheet**, and More contains just 4 links. Events, projects, notes list, timesheet, activity, stock detail, admin — all desktop-only. For an AV tech in a basement with a phone, "is this room free today?" and "log 2h on this task" are currently desktop-only.
- The More sheet itself is a menu-inside-the-tab-bar — acceptable on mobile, but its contents are too sparse; it should be a flat full list of all sections (still one level, not nested).
- Manifest lacks shortcuts (New capture / New ticket / Scan), screenshots, and any install-prompt handling; no web push, so "ticket assigned to you" can't reach a phone that isn't open.
- Desktop is correctly excluded from SW scope — good separation.

## 10. Simplification proposal (no hidden-behind-menus)

Principles: keep the sidebar flat (it already is — no nested menus anywhere, which is right); reduce the **number** of top-level entries instead of nesting them; make the two most frequent actions (capture/report, search) one keystroke away.

Desktop nav, proposed (12 entries, 3 groups):

- **Work**: Overview, Board, Tasks, Projects, Notes, Timesheet, Search (move Capacity into Timesheet as a tab; move Activity into Overview or keep — decide)
- **Places & gear**: Rooms (absorbs Campuses as a filter/grouping inside Rooms; Locations merged or kept as one entry if the data models stay separate — §12 Q4), Inventory (absorbs Stock + Models + Frequencies as tabs)
- **Operations**: Tickets, Events
- **Admin** (admins): Users, Search index, Import/Export, Analytics

Plus: header "+" quick-entry button (visible, not palette-only); palette unchanged (it derives from `nav.ts`, so it follows automatically).
Mobile: keep 4–5 tabs (Rooms, Tasks, Capture, Tickets, More) but make **More a flat full-section list** (Events, Projects, Notes, Timesheet, Search, Board, Stock, Locations, Admin-if-admin) and add the missing mobile routes for events-today, notes list, timer start/stop. Nothing goes two levels deep.

## 11. Executable plan (proposed — awaiting your approval)

Each phase is independently shippable and ends green on `pnpm typecheck && pnpm lint && pnpm format && bash scripts/guards.sh && pnpm test` (+ `pnpm test:e2e` for UI/PWA phases). No phase touches a DB invariant; anything that does goes through the migration procedure in AGENTS.md.

**Phase 0 — decisions.** Answer §12. Output: a signed-off scope list.

**Phase 1 — quick wins (1–2 days).**
1. Caddy: add `encode zstd gzip` scoped to `/assets/*` only; keep `flush_interval -1` and no encode on app paths (SSE safe). Verify with a curl header check in the rehearsal compose.
2. Manifest: real description (localized), screenshots, `shortcuts` (New capture, New ticket, Search), keep scope `/m/`.
3. Nav: move Import/Export out of the misleading "Data & admin" group label (or make it adminOnly — your call, §12 Q5); add a visible header "+" quick-entry button.
4. Login page: minimal brand/value line (one sentence + logo) — the only public page.

**Phase 2 — desktop IA consolidation (3–5 days).**
1. Rooms page gains campus/building grouping; Campuses CRUD moves behind an "Manage campuses" affordance inside Rooms (one level). Nav: drop `Campuses` entry.
2. Inventory becomes one section with tabs (Equipment / Models / Stock / Frequencies); nav: drop `Stock`, `Frequencies` entries. (Routes stay; nav + palette derive from `nav.ts`.)
3. Decide Locations vs Rooms per §12 Q4 (either merge into one "Places" section with tabs, or keep two entries with sharpened labels/copy).
4. Capacity into Timesheet as a tab (or keep — decide); Activity stays.
5. Update `nav.ts`, i18n keys (en+de), command palette follows automatically; update e2e `screens.spec.ts`/`smoke.spec.ts` nav assertions; a11y sweep.

**Phase 3 — mobile parity (5–8 days).**
1. New `/m` routes: events (today/week list + conflict-checked booking create), projects list, notes list, timesheet (start/stop timer + week), stock detail, attachments viewer.
2. Rework More sheet into a flat full-section list (single level); add events/notes/timesheet/board/search links that exist today plus the new routes.
3. Manifest shortcuts wired to those routes; SW precache extended to new shell pages; offline queue untouched (capture stays the offline-write path).
4. e2e: extend `mobile-session.spec.ts`/`mobile-offline.spec.ts`; a11y sweep on new routes.

**Phase 4 — feature gaps, in your priority order (§12 Q3).** Each is its own small PR with migration procedure if the schema changes:
1. Notification center (in-app inbox over ActivityLog + due-date/assignment/booking events) + optional web push on the PWA.
2. QR codes for rooms/equipment (deep links already exist; render QR client-side, no new dependency or a tiny one).
3. Recurring events (RRULE column + EXCLUDE-compatible expansion; migration + booking-constraint tests).
4. Comments on tasks/tickets (new model + audit + realtime; UI thread under detail).
5. Ad-hoc equipment checkout/check-in (reuses `EquipmentAllocation` with a non-event scope or a new `Loan` model).
6. Per-user timezone (user column, display-side only; DB stays UTC — a contained change).
7. 2FA / SSO via Better Auth; API tokens + webhooks.

**Phase 5 — marketing surface (only if §12 Q1 says external adoption).**
1. Public landing + docs site (separate from this repo or a `/site` folder), screenshots generated from the demo workspace, feature/comparison copy in en+de.
2. Optional hosted read-only demo (explicitly breaks the "no hosted service" rule — needs a decision).

## 12. Ambiguities — answered 2026-11-07 (decisions locked)

1. **Marketing scope → "Public site + demo".** External adoption is the goal: a public landing/docs site and a hosted demo are in scope. Note this directly contradicts the repo's current "No hosted service" limitation in README/ARCHITECTURE — those statements and the deployment story must be revisited as part of the plan.
2. **Tenancy → "Multi-tenant SaaS".** The one-workspace-per-install model is to be replaced by multi-tenant. This is the largest architectural program in this report: tenant scoping on every model/query, auth/workspace membership, per-tenant config (locale, storage, optional AI/CalDAV), and ops. README/ARCHITECTURE "one workspace per deployment" limitation goes away.
3. **Phase-4 gap order → "Notifications + QR + mobile parity first."** In-app notification center (+ optional web push), QR codes for rooms/equipment, and mobile PWA parity are the first feature investments; recurring events, comments, ad-hoc loans, per-user TZ, 2FA/SSO follow after.
4. **Places → "Unify into one model."** One places tree (the `Location` lineage) with bookable nodes replacing the separate `Campus/Building/Room` trio; migration touching Room/Location/Campus plus rooms/events/tickets/stock/notes domains. Biggest single migration in the plan.
5. **Import/Export → admin-only.** Add `requireRole(ADMIN)` to `/import` and the `adminOnly` nav flag.
6. **Compression → `/assets/*` only.** Enable `encode zstd gzip` for hashed assets in the Caddyfile; app/SSE paths stay uncompressed with `flush_interval -1`.
7. **Languages → "More locales later."** Ship en/de now; keep the catalog structure so adding a locale stays a catalog-pair addition. No third locale in the near-term plan.

---

*Prepared as an audit only. No code, migration, config or documentation file of the project was changed; this report is the single new file.*
