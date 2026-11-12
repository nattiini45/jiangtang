CREATE TYPE "FieldLevel" AS ENUM ('MODEL', 'DEVICE');
ALTER TYPE "CustomFieldType" ADD VALUE 'RANGE';
ALTER TABLE "CustomField" ADD COLUMN "level" "FieldLevel" NOT NULL DEFAULT 'DEVICE',
  ADD COLUMN "renamed" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT custom_field_library_scope CHECK ("systemKey" IS NULL OR scope = 'EQUIPMENT');
ALTER TABLE "CustomFieldOption" ADD COLUMN "systemKey" TEXT;
CREATE UNIQUE INDEX "CustomFieldOption_fieldId_systemKey_key" ON "CustomFieldOption"("fieldId", "systemKey");
ALTER TABLE "EquipmentModel" ADD COLUMN "customValues" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "EquipmentModel" ADD CONSTRAINT equipment_model_custom_values
  CHECK (jsonb_typeof("customValues") = 'object' AND pg_column_size("customValues") <= 32768);
CREATE TABLE "LibraryState" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "version" INTEGER NOT NULL,
  "appliedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
