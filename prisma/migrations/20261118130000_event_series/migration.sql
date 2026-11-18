CREATE TABLE "EventSeries" (
    "id" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "nextDate" TEXT,
    "stopsBefore" TEXT,
    "exceptions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "conflictDates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "EventSeries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Event" ADD COLUMN "occurrenceKey" TEXT, ADD COLUMN "seriesId" TEXT;
ALTER TABLE "Event" ADD CONSTRAINT "event_series_occurrence_key" CHECK ("seriesId" IS NULL OR "occurrenceKey" IS NOT NULL);
CREATE INDEX "EventSeries_nextDate_idx" ON "EventSeries"("nextDate");
CREATE UNIQUE INDEX "Event_seriesId_occurrenceKey_key" ON "Event"("seriesId", "occurrenceKey");
ALTER TABLE "Event" ADD CONSTRAINT "Event_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "EventSeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
