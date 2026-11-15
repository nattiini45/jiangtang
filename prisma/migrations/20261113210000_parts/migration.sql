ALTER TABLE "InventoryItem" ADD COLUMN "modelId" TEXT;

CREATE TABLE "ModelPartFit" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "partModelId" TEXT NOT NULL,
    "quantity" INTEGER,
    "sourceUrl" TEXT,
    "catalogKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelPartFit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "model_part_fit_values" CHECK (
      "modelId" <> "partModelId" AND ("quantity" IS NULL OR "quantity" > 0)
    )
);
CREATE INDEX "ModelPartFit_partModelId_idx" ON "ModelPartFit"("partModelId");
CREATE UNIQUE INDEX "ModelPartFit_modelId_partModelId_key" ON "ModelPartFit"("modelId", "partModelId");
CREATE INDEX "InventoryItem_modelId_idx" ON "InventoryItem"("modelId");
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_modelId_fkey"
  FOREIGN KEY ("modelId") REFERENCES "EquipmentModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ModelPartFit" ADD CONSTRAINT "ModelPartFit_modelId_fkey"
  FOREIGN KEY ("modelId") REFERENCES "EquipmentModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelPartFit" ADD CONSTRAINT "ModelPartFit_partModelId_fkey"
  FOREIGN KEY ("partModelId") REFERENCES "EquipmentModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
