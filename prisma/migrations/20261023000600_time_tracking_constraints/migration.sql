-- Functional baseline, file 7 of 7: time tracking constraints.
--
-- Responsibility: the two TimeEntry invariants that Prisma cannot model, and
-- which 20261023000100_core_schema therefore created the table without: the
-- positive-interval CHECK and the partial unique index that allows at most one
-- running timer per user. The table, its primary key, its three foreign keys
-- and its two ordinary btree indexes are file 2's work, not this file's.
--
-- The CHECK is the catalog's recorded check_expression, written as the catalog
-- records it: (("endsAt" IS NULL) OR ("endsAt" > "startsAt")). It is a table
-- CHECK - constraint type 'c', no backing index, validated, not deferrable, not
-- inherited - so it is an ALTER TABLE ... ADD CONSTRAINT after the table exists,
-- not an inline column constraint. NULL "endsAt" is the running-timer sentinel,
-- not a zero-length entry: an open entry is allowed, a finished entry must have
-- strictly positive duration, and an entry that ends exactly at its start is
-- rejected.
--
-- The index is the catalog's recorded partial unique index, written as the
-- catalog records it: UNIQUE btree on ("userId") with predicate
-- ("endsAt" IS NULL). Because the predicate matches only rows whose timer is
-- still running, uniqueness applies to running rows alone: a user may hold at
-- most one open entry, and any number of closed ones.
--
-- Finished overlapping entries stay valid, and that is a property of these two
-- objects, not an omission: the predicate is "endsAt IS NULL", not an overlap
-- test, and no EXCLUDE constraint is placed on TimeEntry's time range anywhere
-- in the baseline. Two entries with endsAt NOT NULL are outside the index's
-- predicate entirely, so they neither compete for uniqueness nor collide with
-- each other, and the CHECK permits them as long as each one is individually
-- positive. A running entry may also overlap a finished one - only one running
-- entry per user can exist, which is what the index enforces. The measured
-- objects do reproduce the contract note; there is no discrepancy to report.
--
-- Deliberately absent from this file, by design:
--   * any overlap EXCLUDE constraint on TimeEntry, and any generated range
--     column to back one - the reference holds two EXCLUDE constraints in
--     total, both booking constraints written by 20261023000200_booking_constraints,
--     and TimeEntry is not among them;
--   * IF NOT EXISTS guards on the constraint or the index - a fresh install has
--     neither, and a guard would silently accept a conflicting pre-existing
--     object;
--   * every drop, rename or recreate step: the object matrix records
--     altered_after_creation = false for both objects. They are created once,
--     in the text this file carries as the final state. The statements that
--     `prisma migrate diff` re-proposes for the folded Chunk artefacts are the
--     reference run's recorded residuals, not history; they are not repeated
--     here.
--     The reference run also records that, measured after apply, the diff engine
--     was blind to this CHECK and to this filtered index, so neither is
--     re-proposed - a statement about the historical tool, not a check this
--     package ran.

-- ===========================================================================
-- Positive interval
-- ===========================================================================

ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "time_entry_interval_positive"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");

-- ===========================================================================
-- One running timer per user
-- ===========================================================================

CREATE UNIQUE INDEX "time_entry_one_running_per_user"
  ON "TimeEntry" ("userId")
  WHERE "endsAt" IS NULL;
