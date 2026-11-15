ALTER TABLE "CustomField" ADD COLUMN "store" TEXT NOT NULL DEFAULT 'VALUE';

CREATE TABLE "EquipmentReading" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "equipmentId" TEXT NOT NULL REFERENCES "Equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "fieldId" TEXT NOT NULL REFERENCES "CustomField"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "value" JSONB NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "source" TEXT NOT NULL,
  "sourceRef" TEXT,
  "partModelId" TEXT REFERENCES "EquipmentModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recordedById" TEXT REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT equipment_reading_source CHECK ("source" IN ('typed', 'round', 'replacement', 'network'))
);

CREATE INDEX "EquipmentReading_equipmentId_fieldId_observedAt_createdAt_i_idx"
  ON "EquipmentReading"("equipmentId", "fieldId", "observedAt" DESC, "createdAt" DESC, "id" DESC);

CREATE FUNCTION prevent_reading_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Equipment readings are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER equipment_reading_immutable BEFORE UPDATE OR DELETE ON "EquipmentReading"
  FOR EACH ROW EXECUTE FUNCTION prevent_reading_change();
ALTER TABLE "EquipmentReading" ENABLE ALWAYS TRIGGER equipment_reading_immutable;
