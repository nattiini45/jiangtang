# Places unification design (specification — not implemented in this release)

Status: **design only.** The locked audit decision (§12.4, "Unify into one model") asks for one
places tree with bookable nodes replacing the separate `Campus`/`Building`/`Room` trio. This
document is that plan; no code or migration here changes anything yet. When executed, the
[ARCHITECTURE.md](ARCHITECTURE.md) data-model table rows for "Places for AV work" and "Location
spine" merge into one row linking this doc.

## Current state (the duplication)

- `Campus → Building → Room` is the AV-booking hierarchy: rooms carry capabilities
  (`hasProjector`, …), status, external links, and are the target of `EventRoomBooking` (the
  GiST `EXCLUDE` no-double-booking constraint) and `ServiceWindow`.
- `Location` is a separate self-referencing tree (`LocationKind`: SITE, BUILDING, ROOM, STORAGE,
  RACK, VEHICLE, …) used by stock (`InventoryItem.locationId`), tasks and notes.
- The two hierarchies overlap semantically (a campus IS a site, a room IS a room) and the UI
  already shows them side by side (`/rooms` with campus filter, `/locations` tree, stock picker
  mixing both). Data can drift: the same physical room exists as `Room` and as `Location`.

## Target

One places tree — the `Location` lineage — where **bookable nodes** replace `Room`:

- `Location.kind` already has ROOM; add `bookable Boolean @default(false)` plus the room-only
  attributes currently on `Room` (capabilities, status, external links, slug, campus/building
  pointers become `parentId`).
- `Campus` maps to `kind: SITE`, `Building` to `kind: BUILDING`, `Room` to `kind: ROOM` +
  `bookable: true`, carrying every column over.

## Migration plan (biggest single migration in the plan — batched)

1. Additive: new columns on `Location` (nullable `slug`, `status`, capability flags, links,
   `bookable`); `Room` keeps working (dual-write via a Prisma middleware or in the domain
   mutations while both tables exist).
2. Backfill: one `Location` row per `Campus`/`Building`/`Room`, reparented into one tree;
   store the old id on the new row (`legacyRoomId`) for FK repointing.
3. Repoint every FK that references `Room` (`EventRoomBooking.roomId`, `ServiceWindow.roomId`,
   `Equipment.roomId`, `Ticket.roomId`, `Attachment.roomId`, `Room.campusId/buildingId`) to
   `Location`. This is the mechanical bulk; each repoint is its own migration folder so a failure
   is isolated.
4. Move the booking constraint: the generated `during` range + `EXCLUDE USING gist` moves to a
   booking table keyed by `locationId`; the existing constraint tests (`events.mutations.test.ts`
   etc.) are ported to the new table with the same semantics — **the no-double-booking invariant
   is never weakened or dropped during the move** (the CI guard on `during` columns covers the new
   table from the start).
5. Switch reads in the rooms domain to `Location` (`listRooms` becomes a `kind=ROOM, bookable`
   query), update routes/nav copy, then drop `Campus`/`Building`/`Room` in a final migration after
   a full e2e pass.

## Domain impact

- `rooms` domain: queries/mutations over `Location`; the campuses manage-mode UI becomes
  "manage sites/buildings" on the locations tree.
- `events` domain: bookings/allocation reference `Location`; conflict queries use
  `kind=ROOM AND bookable`.
- `inventory`/`tickets`/`tasks`/`notes`/`attachments`: `roomId` fields become `locationId`
  (mechanical rename + FK swap).
- Search index and audit `entityType` vocabulary: `room`/`campus`/`building` merge into
  `location` with `data.kind` preserving the old value for history rows (append-only log keeps
  old strings; readers map them).

## Test strategy

- Port the EXCLUDE-constraint tests to the new booking table (overlap rejected, back-to-back
  allowed, cancel frees the slot) before any read switch.
- A migration test that backfills a known `Campus/Building/Room` fixture into the expected
  `Location` tree with fields preserved.
- Route-level tests: every `/rooms/...` URL keeps resolving (route-resolution test updated to the
  new ids), old room slugs redirect or 404 deliberately (decision: keep `slug` on Location and
  serve `/rooms/:slug` from it, so old links keep working).
- e2e: screens/i18n-sweep/a11y suites re-run; the `/rooms?manage=campuses` manage mode becomes the
  locations manage mode.

## Rollout order

Additive columns → backfill → dual-write → FK repoint (batched per referencing table) → read
switch behind a flag → drop old tables. Each step has its own migration folder and its tests;
nothing is dropped before a full green e2e.

## Required wording changes when implemented

- ARCHITECTURE.md data-model table: the `Campus → Building → Room` and `Location` rows merge into
  one "Places" row linking this doc.
- README features bullet "Locations, stock and equipment" wording updated to the unified tree.
