-- Idempotent on purpose: an unmerged revision of this change shipped the same
-- statements as 20261105000000_calendar_outbox_retry, so a database that applied
-- that revision already has both objects and must still deploy cleanly.

-- AlterEnum
ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

-- AlterTable
ALTER TABLE "CalendarOutbox" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ(3);
