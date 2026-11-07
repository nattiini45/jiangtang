-- Optimistic-concurrency token for the note editor. Existing rows start at 1;
-- an editor opened before this migration has no version and must reload.
ALTER TABLE "Note" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
