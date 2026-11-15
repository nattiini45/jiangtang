CREATE TABLE "EquipmentFunctionGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "systemKey" TEXT,
    "name" TEXT NOT NULL CONSTRAINT "equipment_function_group_name" CHECK (length(btrim("name")) BETWEEN 1 AND 60),
    "position" INTEGER NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE "EquipmentKind" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "systemKey" TEXT,
    "name" TEXT NOT NULL CONSTRAINT "equipment_kind_name" CHECK (length(btrim("name")) BETWEEN 1 AND 60),
    "groupId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "tracksFrequency" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE "EquipmentKindsInitialization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "locale" TEXT NOT NULL
);
ALTER TABLE "Equipment" ADD COLUMN "kindId" TEXT;
ALTER TABLE "EquipmentModel" ADD COLUMN "kindId" TEXT;
CREATE UNIQUE INDEX "EquipmentFunctionGroup_systemKey_key" ON "EquipmentFunctionGroup"("systemKey");
CREATE UNIQUE INDEX "EquipmentKind_systemKey_key" ON "EquipmentKind"("systemKey");
CREATE UNIQUE INDEX "equipment_function_group_active_name" ON "EquipmentFunctionGroup"(lower("name")) WHERE "archivedAt" IS NULL;
CREATE UNIQUE INDEX "equipment_kind_active_name" ON "EquipmentKind"(lower("name")) WHERE "archivedAt" IS NULL;
CREATE INDEX "EquipmentKind_groupId_idx" ON "EquipmentKind"("groupId");
CREATE INDEX "Equipment_kindId_idx" ON "Equipment"("kindId");
CREATE INDEX "EquipmentModel_kindId_idx" ON "EquipmentModel"("kindId");
ALTER TABLE "EquipmentKind" ADD CONSTRAINT "EquipmentKind_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "EquipmentFunctionGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EquipmentModel" ADD CONSTRAINT "EquipmentModel_kindId_fkey" FOREIGN KEY ("kindId") REFERENCES "EquipmentKind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_kindId_fkey" FOREIGN KEY ("kindId") REFERENCES "EquipmentKind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
