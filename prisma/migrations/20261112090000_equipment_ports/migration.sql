CREATE TYPE "PortDirection" AS ENUM ('INPUT', 'OUTPUT', 'BIDIRECTIONAL');
CREATE TYPE "PortSignal" AS ENUM ('VIDEO', 'AUDIO', 'AUDIO_VIDEO', 'CONTROL', 'NETWORK', 'USB', 'POWER', 'OTHER');

CREATE TABLE "EquipmentModelPort" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "direction" "PortDirection" NOT NULL,
    "signal" "PortSignal" NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "EquipmentModelPort_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EquipmentPort" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "direction" "PortDirection" NOT NULL,
    "signal" "PortSignal" NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,
    "modelPortId" TEXT,
    CONSTRAINT "EquipmentPort_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EquipmentModelPort_modelId_label_key" ON "EquipmentModelPort"("modelId", "label");
CREATE INDEX "EquipmentPort_modelPortId_idx" ON "EquipmentPort"("modelPortId");
CREATE UNIQUE INDEX "EquipmentPort_equipmentId_label_key" ON "EquipmentPort"("equipmentId", "label");

ALTER TABLE "EquipmentModelPort" ADD CONSTRAINT "EquipmentModelPort_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "EquipmentModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EquipmentPort" ADD CONSTRAINT "EquipmentPort_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EquipmentPort" ADD CONSTRAINT "EquipmentPort_modelPortId_fkey" FOREIGN KEY ("modelPortId") REFERENCES "EquipmentModelPort"("id") ON DELETE SET NULL ON UPDATE CASCADE;
