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
| M2 | Phase 2 | Desktop IA consolidation: nav restructure (Places/Inventory tabs, campuses into Rooms, capacity into Timesheet), header quick-entry button | in_progress | orchestrator (impl) | see Handoff M2 |
| M3 | Phase 3 | Mobile parity: /m events-today, projects, notes list, timesheet timer, stock detail; flat full More sheet; SW precache + shortcuts | pending | | see Handoff M3 |
| M4 | Phase 4a | In-app notification center (model + inbox UI + realtime + triggers: assignment, due soon, booking conflict, warranty) | pending | | see Handoff M4 |
| M5 | Phase 4b | QR codes on room/equipment pages (scan → deep link / quick ticket) | pending | | see Handoff M5 |
| M6 | Phase 5 | Public marketing landing route (anonymous `/`), docs copy, PUBLIC allowlist entry; hosted-demo ops spec | pending | | see Handoff M6 |
| M7 | Phase 6 | Multi-tenant + places-model unification: prepared design specs only (no execution this session) | pending | | see Handoff M7 |

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

### Handoff M4 — notification center
- In scope: prisma schema + one new migration (`Notification` model), `app/domains/notifications/`,
  routes for inbox (desktop + `/m`), `app/components/notifications/`, realtime emit on triggers
  (task assigned, due soon sweep job, booking conflict, warranty expiry — reuse warranty boot
  job), i18n catalogs (new `notifications.ts` area both locales + register in `app/i18n/index.ts`),
  tests (unit + db), e2e smoke.
- Out of scope: web push in this milestone (spec only), everything else.
- Acceptance: gates §4 incl. migration-baseline test update if the chain shape is pinned, guards,
  `ops/postgres/verify-invariants.sql` untouched unless a new invariant is added.

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

## Open questions / blockers

- Reviewer model: `config_name: "glm-5.3"` is rejected in this environment (subagent_type_not_found, twice), so reviewer rounds run as instructions-only children; recorded per round in the review log.
- Real PWA screenshots (vs generated branded placeholders in M1) need a browser capture pass —
  scheduled after M3, when the mobile UI is final.
