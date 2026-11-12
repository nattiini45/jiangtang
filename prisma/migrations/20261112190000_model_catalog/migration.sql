ALTER TABLE "EquipmentModel"
  ADD COLUMN "catalogKey" TEXT,
  ADD COLUMN "catalogSnapshot" JSONB,
  ADD COLUMN "catalogVersion" INTEGER;

CREATE UNIQUE INDEX "EquipmentModel_catalogKey_key" ON "EquipmentModel"("catalogKey");
