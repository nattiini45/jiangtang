CREATE TYPE "FunctionRole" AS ENUM ('CARRIER', 'PATH');
CREATE TYPE "FaultImpact" AS ENUM ('DOWN', 'LIMITED');
CREATE TYPE "TicketChannel" AS ENUM ('DESKTOP', 'PHONE', 'ROUND', 'EMAIL', 'GLOBALVIEWER', 'MCP');

ALTER TABLE "Equipment" ADD COLUMN "statusSince" TIMESTAMPTZ(3);
ALTER TABLE "Ticket" ADD COLUMN "channel" "TicketChannel",
ADD COLUMN "functionId" TEXT,
ADD COLUMN "impact" "FaultImpact",
ADD COLUMN "keepAsFix" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_impact_values" CHECK ("impact" IS NULL OR "impact" IN ('DOWN', 'LIMITED'));

CREATE TABLE "RoomFunction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "systemKey" TEXT,
  "name" TEXT NOT NULL,
  "renamed" BOOLEAN NOT NULL DEFAULT false,
  "position" INTEGER NOT NULL,
  "archivedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE "RoomFunctionKind" (
  "functionId" TEXT NOT NULL,
  "kindId" TEXT NOT NULL,
  "role" "FunctionRole" NOT NULL,
  PRIMARY KEY ("functionId", "kindId")
);
CREATE UNIQUE INDEX "RoomFunction_systemKey_key" ON "RoomFunction"("systemKey");
CREATE INDEX "RoomFunctionKind_kindId_idx" ON "RoomFunctionKind"("kindId");
CREATE INDEX "Ticket_functionId_idx" ON "Ticket"("functionId");
CREATE INDEX "Ticket_roomId_status_idx" ON "Ticket"("roomId", "status");
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "RoomFunction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoomFunctionKind" ADD CONSTRAINT "RoomFunctionKind_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "RoomFunction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomFunctionKind" ADD CONSTRAINT "RoomFunctionKind_kindId_fkey" FOREIGN KEY ("kindId") REFERENCES "EquipmentKind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "Equipment" e SET "statusSince" = evidence.at
FROM (
  SELECT a."entityId", max(a."occurredAt") AS at
  FROM "ActivityLog" a
  WHERE a."entityType" = 'equipment' AND a.action = 'EquipmentRetired'
  GROUP BY a."entityId"
) evidence WHERE e.id = evidence."entityId" AND e.status = 'RETIRED';
