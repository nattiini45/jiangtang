# WORKSTATE — shared orchestration state

**Every agent (orchestrator, implementers, reviewers) MUST read this file first and update it
before ending its turn.** It is the single source of truth for what is being built, what is
done, and what a handoff may touch. The full analysis behind the phases lives in
`AUDIT-REPORT.md` (root); the locked decisions are in its §12.

## Rules of engagement

1. Read `WORKSTATE.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/conventions.md` before any
   change. Follow the golden rules and guards exactly (`bash scripts/guards.sh` must pass).
2. Work only inside the **scope block of your current milestone** (below). Do not touch files
   listed as out of scope. Do not refactor unrelated code.
3. Before finishing your turn, update this file: set your milestone's status, append to the
   milestone's log, and fill the review-log entry if you reviewed.
4. Verification gate for every milestone: `pnpm typecheck`, `pnpm lint`, `pnpm format` (changed
   files), `bash scripts/guards.sh`, and `pnpm test` with
   `DATABASE_URL=postgres://jiangtang:jiangtang@127.0.0.1:55440/jiangtang` (the local dev DB
   container `jiangtang-redesign-db`; Vitest derives a sibling `_test` DB from it — never the
   dev DB). UI/PWA milestones also run `pnpm test:e2e`.
5. Commits: one logical change per commit on the current branch, message format
   `area: what changed`, suffixed with the Mistral Vibe co-author trailer.
6. Migrations: append-only new folder under `prisma/migrations/`, drafted with
   `prisma migrate diff --from-migrations … --to-schema …`, hand-edited per AGENTS.md, applied
   with `DATABASE_URL=… pnpm db:deploy` (local dev DB only), then `pnpm db:generate`. Never
   `db push`, never edit an applied migration.

## Status legend

`pending` → `in_progress` → `in_review` → `done` (reviewer agreed) | `blocked` (reason noted)

## Milestones

| # | Phase | Milestone | Status | Owner | Scope block |
| --- | --- | --- | --- | --- | --- |
| M0 | setup | Work-state mechanism + baseline checks green | done | orchestrator | WORKSTATE.md only |
| M1 | Phase 1 | Quick wins: Caddy `/assets` compression, manifest (description/screenshots/shortcuts), import admin-only, login brand line | done | orchestrator (impl) / reviewer-m1 (review) | see Handoff M1 |
| M2 | Phase 2 | Desktop IA consolidation: nav restructure (Places/Inventory tabs, campuses into Rooms, capacity into Timesheet), header quick-entry button | done | orchestrator (impl) / reviewer-m2 (review) | see Handoff M2 |
| M3 | Phase 3 | Mobile parity: /m events-today, projects, notes list, timesheet timer, stock detail; flat full More sheet; SW precache + shortcuts | done | orchestrator (impl) / reviewer-m3 (review) | see Handoff M3 |
| M4 | Phase 4a | In-app notification center (model + inbox UI + realtime + triggers: assignment, due soon, booking conflict, warranty) | done | orchestrator (impl) / reviewer-m4 (review) | see Handoff M4 |
| M5 | Phase 4b | QR codes on room/equipment pages (scan → deep link / quick ticket) | done | orchestrator (impl) / reviewer-m5 (review) | see Handoff M5 |
| M6 | Phase 5 | Public marketing landing route (anonymous `/`), docs copy, PUBLIC allowlist entry; hosted-demo ops spec | done | orchestrator (impl) / reviewer-m6 (review) | see Handoff M6 |
| M7 | Phase 6 | Multi-tenant + places-model unification: prepared design specs only (no execution this session) | done | orchestrator (impl) / reviewer-m7 (review) | see Handoff M7 |

## Handoff blocks (one per milestone; filled when the milestone starts)

### Handoff M0 — setup
- Scope: `WORKSTATE.md`, `AUDIT-REPORT.md` only. No code.
- Acceptance: baseline `pnpm typecheck && pnpm lint && bash scripts/guards.sh` green on the
  current tree; DB reachable at the dev URL above.
- Log: —

### Handoff M1 — quick wins
- In scope: `Caddyfile`, `public/manifest.webmanifest`, `public/shots/*` (new, generated),
  `scripts/gen-manifest-screenshots.mjs` (new), `app/routes/_desktop.import/route.tsx`,
  `app/components/layout/nav.ts`, `app/routes/login/route.tsx`, `app/i18n/catalog/{en,de}/auth.ts`,
  `app/i18n/catalog/{en,de}/shell.ts`, tests referencing `/import` or login.
- Out of scope: everything else, incl. all other routes, prisma schema, sw.js.
- Changes: (1) Caddyfile `encode zstd gzip` restricted to `@assets path /assets/*` (SSE/app
  paths stay unbuffered, `flush_interval -1` stays); (2) manifest: real `description`,
  `lang`, `dir`, `categories`, generated `screenshots`, `shortcuts` (Capture `/m/`, Search
  `/m/search`, Tasks `/m/tasks`); (3) `/import` becomes `requireRole(ADMIN)` + `adminOnly` in
  nav; (4) login page gains a brand block (logo mark + name + one-line localized value
  proposition) — new i18n keys in both catalogs.
- Acceptance: gates in Rules §4 pass; `route-auth-guard.test.ts` still green (import stays
  protected — it just additionally requires ADMIN; check the guard test's expectations);
  manifest validates as JSON and screenshots exist; Caddyfile parses
  (`docker compose -f docker-compose.rehearsal.yml config` if available, else careful review).

### Handoff M2 — desktop IA consolidation (UI-level; data models unchanged)
- Log: started after M1 review round 2 APPROVED (f23a48d). Interpretation note: the "≤12 entries in 3 groups" count conflicts with the handoff's own enumeration (which lists 4 groups and keeps Timesheet + Activity); implemented the concrete mapping — only the four folded entries (Campuses, Stock, Frequencies, Capacity) leave the nav, everything else stays. Old URLs (/campuses, /capacity, /frequencies, /inventory/stock, /inventory/models) become redirects to the tab/manage views; route modules kept as redirect stubs so route-resolution pins hold.
- Implemented in 4 commits: 0f71686 (nav −4 entries + header "+" quick-entry → /quick-entry), 101b3e9 (campus CRUD → /rooms?manage=campuses, /campuses redirect stub), c286e49 (/inventory?tab=equipment|models|stock|frequencies; models/stock/frequencies index routes → redirect stubs, stock forwards query), cee0bb7 (/timesheet?tab=capacity, /capacity redirect stub). Panels extracted to components (campuses-manager, models-panel, stock-panel, frequency-panel, capacity-panel). Tests updated: inventory-stock-routes + location-stock-routes now call the tab loader; structural boundary test covers the redirect stub.
- Verification: typecheck 0, lint 0, prettier clean (after fix commit 65067e7), guards OK, `pnpm test` 151 files / 1794 passed / 0 failed, `pnpm test:e2e` 150/150, plus @screens subset (dashboard/rooms/inventory/timesheet/capacity × light+dark) 10/10 — /capacity redirect still renders the "Kapazität" h1 marker. Live dev-server curl check: /campuses→/rooms?manage=campuses, /capacity→/timesheet?tab=capacity, /frequencies→/inventory?tab=frequencies, /inventory/models→/inventory?tab=models, /inventory/stock?location=…→/inventory?location=…&tab=stock, all 302 with the expected targets; tab/manage pages 200 with correct h1; folded routes absent from the rendered nav; header quick-entry link present. Review: round 1 CHANGES_REQUESTED (prettier wrap + screens citation) → fixed in 65067e7 → round 2 APPROVED. M2 done.
- In scope: `app/components/layout/nav.ts`, `app/components/layout/app-shell.tsx`,
  `app/components/command/verbs.ts` (only if needed — verbs derive from nav), the rooms /
  campuses / inventory / stock / frequencies / capacity / timesheet route folders **only to
  add grouping/tabs or redirects**, i18n catalogs for renamed/removed nav keys, e2e specs that
  assert nav labels/URLs (`e2e/screens.spec.ts`, `smoke.spec.ts`, `keyboard-flow.spec.ts`).
- Out of scope: prisma schema, migrations, mobile routes, domains' business logic.
- Changes: nav reduced to ≤12 entries in 3 groups (Work: Overview, Board, Tasks, Projects,
  Notes, Search; Places & gear: Rooms, Locations, Inventory; Operations: Tickets, Events;
  Admin: Import/Export, Analytics, Users, Search index). Campuses CRUD becomes a manage-mode
  inside `/rooms` (or a `/rooms?manage=campuses` view) — no separate nav entry. Inventory
  becomes one route with tabs Equipment/Models/Stock/Frequencies (keep old URLs working as
  redirects to the tab). Capacity becomes a tab on `/timesheet`. Header gets a visible "+"
  quick-entry button linking `/quick-entry`. Activity stays in Work. All entries remain one
  level deep — no nested menus.
- Acceptance: gates §4; e2e nav assertions updated; i18n parity test green; command palette
  still lists every nav entry.

### Handoff M3 — mobile parity
- In scope: `app/routes/m.*` (new routes + More sheet rework), `app/components/mobile/mobile-shell.tsx`,
  `public/sw.js` (precache new shell pages, bump cache version), `public/manifest.webmanifest`
  (shortcuts), `app/lib/pwa/*` only if needed, i18n catalogs `mobile.ts`/`shell.ts` both locales,
  e2e `mobile-session.spec.ts`, `mobile-offline.spec.ts`, `pwa-signout-cache.spec.ts`, `a11y.spec.ts`.
- Out of scope: desktop routes, prisma schema (reuse existing loaders/queries read-only),
  offline queue semantics (capture stays the only offline-write path).
- Changes: new read/create routes under `/m`: events (today/week list + booking create with
  conflict check), projects list, notes list, timesheet (week + start/stop timer), stock item
  detail; attachments viewing. More sheet becomes a flat single-level list of all sections.
  Manifest shortcuts wired. SW precaches the new shell pages.
- Acceptance: gates §4 + `pnpm test:e2e`; SW cache-version bump keeps sign-out purge working.
- Log: implemented in 22ef7cf. New /m routes: events._index (today/week via new read-only `from`/`to` on listEvents), events.new (event+room booking, client polls /api/events/check-conflict, action re-checks via findRoomConflicts, EXCLUDE stays authoritative), projects._index, notes._index, timesheet._index (week + start/stop timer reusing desktop mutations), inventory.stock.$id (detail + attachments via linked equipment). m.rooms.$slug gained a read-only attachments section. More sheet is now a flat single-level list of all sections. sw.js: SHELL_CACHE v3→v4, SHELL_URLS precaches all /m shell pages (sw.test.ts pins updated); manifest gained an Events shortcut (/m/events). i18n: mobile.* keys added in en+de. e2e: a11y + i18n-sweep cover the new routes, mobile-session has a flat-More-sheet test, pwa-signout-cache asserts /m/events is install-precached. route-resolution TABLE gained /m/inventory/stock/item-01.
- Verification: typecheck 0, lint 0, prettier clean, guards OK, `pnpm test` 151 files / 1801 passed / 0 failed, `pnpm test:e2e` 165/165. Live dev-server smoke: all new /m routes 200 with expected h1s. Reviewer note: intended model glm5.3-flash (high thinking) is not spawnable in THIS session (registry predates the new agent files; probed → subagent_type_not_found), so the review runs as instructions-only fallback again and is recorded as such.

### Handoff M4 — notification center
- In scope: prisma schema + one new migration (`Notification` model), `app/domains/notifications/`,
  routes for inbox (desktop + `/m`), `app/components/notifications/`, realtime emit on triggers
  (task assigned, due soon sweep job, booking conflict, warranty expiry — reuse warranty boot
  job), i18n catalogs (new `notifications.ts` area both locales + register in `app/i18n/index.ts`),
  tests (unit + db), e2e smoke.
- Out of scope: web push in this milestone (spec only), everything else.
- Acceptance: gates §4 incl. migration-baseline test update if the chain shape is pinned, guards,
  `ops/postgres/verify-invariants.sql` untouched unless a new invariant is added.
- Log: implemented in debfa00 (schema + Notification model + migration 20261107161719_notification_inbox; baseline pins updated: migration-baseline, catalog.import-model, schema-guard 52/40, cross-folder-writes map), fe0c8a3 (domain + triggers: notifyTaskAssignedInTx inside createTaskInTx/setTaskAssignees, sweepDueSoon hourly boot job notifications.boot.server.ts (unref'd, cleared on shutdown), BookingConflictError → notifyBookingConflict for conflicting-event organizers/admins in addRoomBooking/addAllocation in a SEPARATE tx after rollback, warranty sweep now writes WARRANTY_EXPIRING per admin dedup'd by item; "notification" added to ENTITY_TYPES + ENTITY_TYPE map), b5a5ed7 (inbox routes /notifications + /m/notifications with shared NotificationList, header bell + unread badge in both shells, layout loaders carry unread count, notifications.ts i18n area en+de registered, sw.js precaches /m/notifications, e2e a11y+i18n-sweep entries). verify-invariants.sql untouched (no new unmodelled invariant).
- Verification: typecheck 0, lint 0, `pnpm format` clean, guards OK, `pnpm test` 152 files / 1809 passed / 0 failed (incl. new notifications.test.ts, updated warranty test), `pnpm test:e2e` 171/171. Note: two e2e re-runs showed Vite HMR ws 400s caused by a stale `pnpm dev` process from an earlier smoke test holding port 24678 — killed it, re-ran green; not a code issue.

### Handoff M5 — QR codes
- In scope: room + equipment detail pages (desktop + mobile), a QR component, dependency
  decision (prefer `qrcode` npm package if registry reachable; else server-side SVG via a small
  vendored encoder — decide and document), i18n keys, e2e.
- Out of scope: schema changes (deep links already exist).
- Acceptance: gates §4 + e2e; QR scans to the room page / quick-entry with roomId.

### Handoff M6 — marketing landing
- In scope: a new public route (anonymous landing at `/` when signed out, or a dedicated
  `/welcome`), `test/routes/route-auth-guard.test.ts` PUBLIC list entry with reason,
  i18n area `landing.ts` both locales, `docs/` marketing copy (feature page), ops spec for the
  hosted demo (doc only), README limitations section update ("no hosted service" changes).
- Out of scope: actual hosted infrastructure/deploy, auth changes.
- Acceptance: gates §4; guard test explicitly covers the new public route; signed-in users
  still land on the dashboard.

### Handoff M7 — multi-tenant + places unification (SPEC ONLY, no execution)
- In scope: `docs/MULTI-TENANCY-DESIGN.md`, `docs/PLACES-UNIFICATION-DESIGN.md` — concrete
  migration plans, scoping strategy (workspaceId column vs row-level security), auth/membership
  model, per-tenant config, test strategy, rollout order, and the README/ARCHITECTURE wording
  changes required. No code, no migration executed.
- Acceptance: orchestrator review; docs link-check passes.

## Review log (reviewer agents append one entry per review round)

| Milestone | Round | Reviewer | Verdict | Findings | Resolution |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — |
| M1 | 1 | reviewer-m1 (fallback model; glm-5.3 config rejected) | CHANGES_REQUESTED | Blocker: Caddyfile:25 `encode zstd gzip @assets` fails `caddy validate` ("module not registered: http.encoders.@assets") — matcher must come first (`encode @assets zstd gzip`, verified valid). Major: `app/lib/pwa/__tests__/manifest.test.ts:35,57` still pins old manifest (`lang` undefined, description "AV-Workspace"), so `pnpm test` is red (2 failed of 1800). Minor: Caddyfile header comment still says "NO `encode` block". Rest of scope verified: ADMIN-only imports (guard test green, 95 tests), nav adminOnly honored in app-shell/verbs, login tagline in both catalogs, manifest JSON + screenshots (390x844/1280x720) OK, e2e 150/150. | Fix loop: reorder the encode directive to `encode @assets zstd gzip` in Caddyfile (and reword the stale header comment); update manifest.test.ts expectations to the new lang/description; re-run `pnpm test` and `caddy validate`. No other changes needed. |
| M1 | 2 | reviewer-m1 (instructions-only fallback; glm-5.3 config rejected again: subagent_type_not_found) | APPROVED | Reviewed 371771d + fix loop (committed as f23a48d). Re-executed evidence: `caddy validate` (caddy:2 container) → "Valid configuration" on the fixed Caddyfile, old directive confirmed failing; guards OK; tsc exit 0; eslint clean; prettier clean; full Vitest 151 files / 1794 passed / 0 failed (round-1's 2 failures resolved); manifest JSON + screenshots (390x844 ×2, 1280x720) + shortcuts in scope verified; ADMIN-only import routes incl. siblings + nav adminOnly + guard test 95/95; login tagline keys in both catalogs. Not executed in this pass: `pnpm test:e2e` (round 1 reported 150/150). | None outstanding — all three round-1 findings resolved in f23a48d. M1 marked done. |
| M2 | 1 | reviewer-m2 (instructions-only fallback; glm-5.3 config rejected) | CHANGES_REQUESTED | Diff 83cd12a..cee0bb7 (25 files, all in Handoff M2 scope) verified: nav −4 folded entries, palette derives from nav (verbs test green), header "+" → /quick-entry, 5 redirect stubs behind requireUser with route-resolution pins intact, stock redirect forwards query + pins tab=stock, campus forms post to /rooms action, capacity tab keeps the "Kapazität" h1 marker, i18n key changes symmetric en+de. One defect: `test/routes/inventory-stock-routes.test.ts:1395` fails `prettier --check` (line introduced after the format pass). One cosmetic: `e2e/screens.spec.ts:140` cites the now-stub `_desktop.capacity/route.tsx:45`. | Fix loop: prettier-wrap the test file, repoint the screens citation; landed as 65067e7. |
| M2 | 2 | reviewer-m2 (same child, round 2) | APPROVED | Verified 65067e7 (2 files, no functional change), prettier --check clean across all 27 files in 83cd12a..65067e7, targeted suites 148/148 (guard 95, route-resolution 22, i18n parity 7, verbs 11, location-stock 13), stock-route suite 61/61, guards OK. Full `pnpm test` / `pnpm test:e2e` not re-run by reviewer (orchestrator: 1794 passed / e2e 150/150 + @screens subset 10/10). | None outstanding. M2 marked done. |
| M3 | 1 | reviewer-m3 (instructions-only fallback; intended glm5.3-flash not resolvable this session — registry predates the new agent files) | APPROVED | Reviewed 22ef7cf: scope-conformant (only allowed listEvents from/to extension outside the listed files); auth guard 101/101 on new routes; conflict check is server-side too (findRoomConflicts + EXCLUDE authoritative); SW v4 precache pins match sw.js exactly, purge prefix intact; manifest shortcut in scope; More sheet flat with all targets real routes; i18n parity 118/118 keys; full suite re-run by reviewer 1801/1801. Two minors: mobile stock rows still linked to the desktop detail page (orphaning /m/inventory/stock/:id); /m/events/new race window could surface BookingConflictError as a 409 boundary leaving an event without booking. | Both fixed in b8e0b58 (rows link to /m/inventory/stock/:id; action catches BookingConflictError → conflict response). Lint+typecheck+targeted tests green after the fix. M3 marked done. |
| M4 | 1 | reviewer-m4 (instructions-only fallback; glm5.3-flash not resolvable this session) | CHANGES_REQUESTED | Reviewed 67b154e..b5a5ed7: migration append-only, guards OK, no audit pollution, triggers in-tx where a mutation exists, conflict notify in separate tx, dedup sweeps, IDOR-safe mark-read, route guards 103/103, boot job unref+shutdown, i18n parity, pins coherent. One MAJOR: notification-list passed payload keys verbatim while templates expect {date} → literal "{date}" rendered for TASK_DUE_SOON/WARRANTY_EXPIRING in both locales. Four minors: no realtime emit on single mark-read; conflict-notify could mask the 409; conflict rows didn't deep-link (entityHref null for booking sub-rows); migration-baseline comments still said "seven". | Fix loop: notificationLabelParams maps dueAt/warrantyExpiresAt→date + render test for all 4 types both locales; emitChange after mark-read; try/catch around conflict-notify always rethrowing original; conflict rows store entityType "event"; comments seven→eight. Landed as aee3186. |
| M4 | 2 | reviewer-m4 (same child, round 2) | APPROVED | All five round-1 fixes verified in aee3186 (labels test 9/9, mark-read emit, guarded conflict-notify, event deep-link, comments); targeted vitest 141/141; guards/typecheck/lint/prettier clean. Two cosmetic notes (stacked doc comments in notification-list.tsx; stale input.entityType field) — non-blocking. | None outstanding. M4 marked done. |

| M5 | 1 | reviewer-m5 (instructions-only fallback; glm5.3-flash not resolvable this session) | APPROVED | Reviewed c7a8c23: qrcode dep installed (registry reachable, lockfile committed), server-side SVG via qr.server.ts (.server.ts seam, no node encoder in client bundle), room QR → /quick-entry?roomId=…, equipment QR → /inventory/:id, all three pages behind requireUser, i18n symmetric, qr.test.ts payload-safety proven, no schema changes, 113/113 targeted tests on the clean commit tree. Minors (non-blocking): imprecise escape-mechanism comment; no dedicated e2e for the QR svg (covered by i18n-sweep + live smoke). | None required. M5 marked done. |
| M6 | 1 | reviewer-m6 (instructions-only fallback; glm5.3-flash not resolvable this session) | APPROVED | Reviewed 37b268c: /welcome public route outside _desktop, getOptionalUser + signed-in redirect to /, PUBLIC entry with reason, guard test 103/103 explicitly covers it, no private data read (loader returns {}), landing i18n area en+de registered, meta title convention holds (mobile-i18n 6/6), doc-links 9/9, README wording no longer claims "no hosted service" absolutely, e2e landing.spec.ts 3/3 (anonymous render, signed-in redirect, login link). | None required. M6 marked done. |
| M7 | 1 | reviewer-m7 (instructions-only fallback; glm5.3-flash not resolvable this session) | APPROVED | Reviewed b32c5df: exactly the 4 allowed files (2 new design docs + README + ARCHITECTURE), no code/migration executed; both plans grounded in the real schema (cross-checked models, FKs, EXCLUDE constraints), append-only step plans, no-double-booking invariant explicitly preserved during the places move, wording changes applied and doc-links 9/9 green, prettier clean. Minors (non-blocking, for the future execution milestone): say "drop the old table wholesale, never DROP COLUMN during" explicitly; Vendor.locationId omission; new docs outside the frozen link-check corpus. | None required. M7 marked done. |
## Open questions / blockers

- Reviewer models: the Mistral-hosted third-party models exist under canonical ids `zai-glm-5-3` (GLM-5.3), `zai-glm-5-3-flash` (GLM-5.3 Flash), `deepseek-v4-1-flash-1017` (DeepSeek V4.1 Flash 1017). `~/.vibe/config.toml` (backups: `config.toml.bak`, `config.toml.bak2`) maps aliases `glm-5.3` / `glm5.3-flash` / `deepseek-flash` to those names, each with `thinking = "high"`; `~/.vibe/agents/<alias>.toml` defines a subagent per alias with `active_model = "<alias>"` (plus `reviewer-high` → `high-thinking` = mistral-large-4-0, thinking high). Spawn reviewers with `config_name: "glm-5.3"` (or `glm5.3-flash` / `deepseek-flash` / `reviewer-high`). All three aliases verified live (`vibe -p --model <alias>` → OK with thinking=high). Caveat: the agent registry is built at session start, so the config_name types are visible only from the NEXT session (or after `/reload` in the TUI) — probed in-session, still subagent_type_not_found. Until then, reviewer rounds run as instructions-only children on the session model, recorded per round in the review log.
- Real PWA screenshots (vs generated branded placeholders in M1) need a browser capture pass —
  scheduled after M3, when the mobile UI is final.
