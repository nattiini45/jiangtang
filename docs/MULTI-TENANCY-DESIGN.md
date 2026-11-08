# Multi-tenancy design (specification — not implemented in this release)

Status: **design only.** No code, migration or config in this repository implements this yet;
the current release stays one-workspace-per-deployment (see the README limitation). This document
is the plan the locked audit decision (§12.2, "Multi-tenant SaaS") asks for. When it is executed,
the README and [ARCHITECTURE.md](ARCHITECTURE.md) wording changes listed at the bottom land in
the same PR.

## Current state

- `User` / `Session` / `Account` / `Verification` are global; there is no workspace concept.
  Every domain query (`app/domains/*`) is implicitly scoped to "the one workspace" by the fact
  that only one exists.
- Per-install config lives in env vars (`DEFAULT_LOCALE`, storage keys, optional AI/CalDAV
  endpoints); nothing is per-tenant.

## Target

Many workspaces (tenants) per deployment, each with its own data, members, and config (locale,
storage prefix, optional AI/CalDAV endpoints). A user can belong to several workspaces and picks
the active one at sign-in / from a switcher.

## Scoping strategy: `workspaceId` column, not RLS (initially)

Two candidate mechanisms:

| Option | Pros | Cons |
| --- | --- | --- |
| **A. `workspaceId` column on every model** + a scoping wrapper around the Prisma client | Explicit, testable in plain Vitest, works with Prisma's type system, easy to reason about in code review | Must be applied consistently; a forgotten `where` leaks across tenants |
| B. PostgreSQL row-level security with `SET LOCAL` session vars | Defense in depth at the DB layer; impossible to forget in raw SQL | Prisma opens pooled connections — session vars must be set per query (`$executeRaw SET LOCAL` inside the same tx); hard to test; interacts badly with migrations and the audit funnel |

**Decision: A now, B later as defense in depth.** A is enforced by convention + tests + a CI
guard (below); RLS can be layered on once A is proven, because the policies then just mirror the
column.

Concretely:

1. New models:
   ```prisma
   model Workspace {
     id        String   @id @default(cuid())
     slug      String   @unique
     name      String
     config    Json?    // { locale, storagePrefix, ai?, caldav? } — per-tenant overrides of env defaults
     members   Membership[]
     createdAt DateTime @default(now()) @db.Timestamptz(3)
   }
   model Membership {
     id          String   @id @default(cuid())
     userId      String
     workspaceId String
     role        UserRole @default(MEMBER) // ADMIN is per-workspace, not global
     user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
     workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
     @@unique([userId, workspaceId])
     @@index([workspaceId])
   }
   ```
   `User.role` becomes global-default only; the effective role is `Membership.role`.
2. Every workspace-owned model gets `workspaceId String` + FK + `@@index([workspaceId])`.
   Workspace-owned = everything except the auth tables, `Workspace`, `Membership`, and
   `Notification` (which moves to `membershipId` or `userId+workspaceId`).
3. Scoping seam: `db.server` exports `forWorkspace(workspaceId)` returning a Prisma client proxy
   that injects `workspaceId` into every `where`/`create`/`update` (Prisma middleware is the
   implementation vehicle). Domain functions change signature from `listTasks(opts)` to
   `listTasks(workspaceId, opts)`; routes get the workspace from the session (see below).
   The existing CI guard pattern (`scripts/guards.sh`) gains a rule: no `db.<model>.` access in
   `app/domains/` without going through `forWorkspace` (enforced by a test that scans for raw
   `db.` delegate calls, mirroring `cross-folder-writes.test.ts`).

## Auth and membership

- Better Auth stays the identity provider; `Session` gains `activeWorkspaceId` (or the active
  workspace is a cookie set on switch). Sign-in lists the user's workspaces; if exactly one, it
  is chosen silently.
- Invitations become per-workspace (`Invite.workspaceId`), issued by that workspace's admins.
- `requireUser` becomes `requireMembership(request)` → `{ user, workspaceId, role }`; every
  route loader/action keeps its own check (the route-auth-guard test extends to assert the
  workspace scope is present).
- GDPR erasure stays per-user; workspace deletion is a separate, admin-only, audited operation
  that cascades memberships and (via the FK cascade) workspace data.

## Migration plan (all append-only, each step deployable)

1. Migration 1: create `Workspace` + `Membership`; create one workspace per existing deployment
   (`"default"`), backfill `Membership` for all users as ADMIN. No model changes yet.
2. Migration 2..N (batched by domain to keep each reviewable): for each owned model, add
   **nullable** `workspaceId`, backfill from the single workspace, add index + FK.
3. Code change behind a flag `MULTI_TENANT=1`: `forWorkspace` seam + domain signatures + routes.
   With the flag off, behavior is byte-identical to today.
4. Migration N+1: set `workspaceId NOT NULL` + unique constraints that include it
   (e.g. `Campus.slug` becomes `@@unique([workspaceId, slug])`).
5. Tests: for every domain, a two-workspace isolation test (create rows in A and B, assert reads
   in A never see B); the route-auth-guard gains a "scoped" dimension; e2e signs into two
   workspaces.

## Rollout order

Auth/membership first (1–3), then domains in dependency order: places (rooms/locations) →
inventory/stock → events/bookings (EXCLUDE constraints gain `workspaceId` in their predicates) →
tasks/tickets/notes/time → search index (Chunk/SearchIndexJob scoped) → notifications. Each step
ships with its isolation tests before the next starts.

## Test strategy

- Unit/DB: per-domain isolation tests as above; the EXCLUDE no-double-booking tests gain a
  cross-workspace case (same room slug in two workspaces must NOT conflict).
- Guard: extend `route-auth-guard.test.ts` to assert every handler resolves a workspace scope;
  extend `scripts/guards.sh` with the no-raw-`db.` rule for domains.
- e2e: two workspaces, two users, cross-tenant invisibility in UI.

## Required wording changes when implemented

- README limitation "One workspace per deployment. There is no multi-tenant mode." → removed,
  replaced by a multi-tenancy section linking this doc.
- ARCHITECTURE.md "One installation serves one team." → updated to the workspace model, linking
  this doc.
