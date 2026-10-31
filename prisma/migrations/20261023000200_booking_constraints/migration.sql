-- Functional baseline, file 3 of 7: booking constraints.
--
-- Responsibility: the booking-integrity objects that Prisma cannot model, and
-- which 20261023000100_core_schema therefore created the two booking tables
-- without: the generated `during` range column on each table, the two
-- conditional GiST exclusion constraints that make a double booking
-- impossible, and the Room renewal-order check.
--
-- Both `during` columns are added here, not in core_schema, and are therefore
-- appended to the end of their tables. That reproduces the reference column
-- order exactly: the catalog records `during` at attnum 8 on both
-- EventRoomBooking and EquipmentAllocation, each table has eight live columns
-- numbered 1..8 with no gap, so attnum 8 is the last position and an
-- ALTER TABLE ... ADD COLUMN lands on it.
--
-- The generation expression is written exactly as the catalog records it,
-- tstzrange("startsAt", "endsAt", '[)'::text), so the stored expression and
-- the half-open [start, end) semantics are the reference ones: back-to-back
-- bookings that merely touch do not overlap, and a real overlap raises
-- SQLSTATE 23P01 (exclusion_violation).
--
-- Both exclusion constraints are written verbatim as the census records them.
-- No explicit operator class and no explicit index options are emitted,
-- because the reference holds none: the GiST keys resolve to the defaults the
-- catalog measures - gist_text_ops from btree_gist (installed by file 1) for
-- the "=" half and range_ops from pg_catalog for the "&&" half - and the
-- backing indexes carry no INCLUDE columns, storage options or tablespace.
-- The WHERE (cancelled = false) predicate is part of the constraint, not an
-- optional flourish: without it a cancelled booking would keep blocking a
-- slot.
--
-- room_renewal_order is a table CHECK constraint, not an index and not an
-- exclusion constraint: the catalog records it with constraint type 'c',
-- check_expression (("renewalFrom" IS NULL) OR ("renewalTo" IS NULL) OR
-- ("renewalFrom" <= "renewalTo")), no backing index, validated and not
-- deferrable. Its final state is written directly here: no drop, rename or
-- recreate step is reproduced.
--
-- Deliberately absent from this file, by design:
--   * CREATE EXTENSION btree_gist - file 1 owns every extension;
--   * IF NOT EXISTS guards on either the columns or the constraints - a fresh
--     install has neither, and a guard would silently accept a conflicting
--     pre-existing object;
--   * every drop, rename or recreate step from the historical chain - these
--     five objects were each created once and never altered;
--   * the TimeEntry interval CHECK and the one-running-timer index
--     (20261023000600_time_tracking_constraints), the Chunk search indexes
--     (20261023000400_search_indexes), and every ordinary index and foreign
--     key on these tables, which file 2 already wrote.

-- ===========================================================================
-- Generated booking ranges
-- ===========================================================================

ALTER TABLE "EventRoomBooking"
  ADD COLUMN during tstzrange
  GENERATED ALWAYS AS (tstzrange("startsAt", "endsAt", '[)'::text)) STORED;

ALTER TABLE "EquipmentAllocation"
  ADD COLUMN during tstzrange
  GENERATED ALWAYS AS (tstzrange("startsAt", "endsAt", '[)'::text)) STORED;

-- ===========================================================================
-- Conditional GiST exclusion constraints
-- ===========================================================================

-- A room cannot host two overlapping events.
ALTER TABLE "EventRoomBooking"
  ADD CONSTRAINT "event_room_no_overlap"
  EXCLUDE USING gist ("roomId" WITH =, during WITH &&)
  WHERE (cancelled = false);

-- A pooled equipment unit cannot be allocated to two overlapping events.
ALTER TABLE "EquipmentAllocation"
  ADD CONSTRAINT "equipment_alloc_no_overlap"
  EXCLUDE USING gist ("equipmentId" WITH =, during WITH &&)
  WHERE (cancelled = false);

-- ===========================================================================
-- Room renewal window
-- ===========================================================================

-- A room's renewal window must not be inverted. Either bound may be unknown;
-- only a present pair with from > to is rejected.
ALTER TABLE "Room"
  ADD CONSTRAINT "room_renewal_order"
  CHECK ("renewalFrom" IS NULL OR "renewalTo" IS NULL OR "renewalFrom" <= "renewalTo");
