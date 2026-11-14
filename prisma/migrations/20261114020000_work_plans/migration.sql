-- AlterTable
ALTER TABLE "EquipmentReading" ADD COLUMN     "planId" TEXT;

-- AlterTable
ALTER TABLE "Round" ADD COLUMN     "planId" TEXT,
ADD COLUMN     "plannedFor" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "WorkPlan" (
    "id" TEXT NOT NULL,
    "systemKey" TEXT,
    "name" TEXT NOT NULL,
    "workType" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalMonths" INTEGER,
    "semester" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "basis" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "assigneeId" TEXT,
    "kindId" TEXT,
    "fieldId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SemesterStart" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SemesterStart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_RoomToWorkPlan" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RoomToWorkPlan_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_EquipmentToWorkPlan" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_EquipmentToWorkPlan_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkPlan_systemKey_key" ON "WorkPlan"("systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkPlan_fieldId_key" ON "WorkPlan"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "SemesterStart_startsAt_key" ON "SemesterStart"("startsAt");

-- CreateIndex
CREATE INDEX "_RoomToWorkPlan_B_index" ON "_RoomToWorkPlan"("B");

-- CreateIndex
CREATE INDEX "_EquipmentToWorkPlan_B_index" ON "_EquipmentToWorkPlan"("B");

-- CreateIndex
CREATE INDEX "EquipmentReading_planId_equipmentId_observedAt_idx" ON "EquipmentReading"("planId", "equipmentId", "observedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Round_planId_plannedFor_key" ON "Round"("planId", "plannedFor");

-- AddForeignKey
ALTER TABLE "EquipmentReading" ADD CONSTRAINT "EquipmentReading_planId_fkey" FOREIGN KEY ("planId") REFERENCES "WorkPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Round" ADD CONSTRAINT "Round_planId_fkey" FOREIGN KEY ("planId") REFERENCES "WorkPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPlan" ADD CONSTRAINT "WorkPlan_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPlan" ADD CONSTRAINT "WorkPlan_kindId_fkey" FOREIGN KEY ("kindId") REFERENCES "EquipmentKind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPlan" ADD CONSTRAINT "WorkPlan_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RoomToWorkPlan" ADD CONSTRAINT "_RoomToWorkPlan_A_fkey" FOREIGN KEY ("A") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RoomToWorkPlan" ADD CONSTRAINT "_RoomToWorkPlan_B_fkey" FOREIGN KEY ("B") REFERENCES "WorkPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EquipmentToWorkPlan" ADD CONSTRAINT "_EquipmentToWorkPlan_A_fkey" FOREIGN KEY ("A") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EquipmentToWorkPlan" ADD CONSTRAINT "_EquipmentToWorkPlan_B_fkey" FOREIGN KEY ("B") REFERENCES "WorkPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkPlan" ADD CONSTRAINT "work_plan_schedule" CHECK (
  (semester AND "intervalMonths" IS NULL) OR
  (NOT semester AND "intervalMonths" IS NOT NULL AND "intervalMonths" BETWEEN 1 AND 120)
);
ALTER TABLE "WorkPlan" ADD CONSTRAINT "work_plan_target" CHECK (
  ("workType" = 'round' AND target = 'rooms') OR
  ("workType" = 'inspection' AND target IN ('portable', 'kind', 'devices'))
);
