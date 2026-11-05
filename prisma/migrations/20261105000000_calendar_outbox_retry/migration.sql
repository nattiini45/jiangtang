-- AlterEnum
ALTER TYPE "OutboxStatus" ADD VALUE 'SUPERSEDED';

-- AlterTable
ALTER TABLE "CalendarOutbox" ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3);
