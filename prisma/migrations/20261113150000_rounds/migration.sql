-- CreateEnum
CREATE TYPE "CheckResult" AS ENUM ('WORKS', 'LIMITED', 'DOWN', 'NOT_CHECKED');
-- CreateTable
CREATE TABLE "Round" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startedById" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundRoom" (
    "roundId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RoundRoom_pkey" PRIMARY KEY ("roundId","roomId")
);

-- CreateTable
CREATE TABLE "RoomCheck" (
    "id" TEXT NOT NULL,
    "roundId" TEXT,
    "roomId" TEXT NOT NULL,
    "functionId" TEXT NOT NULL,
    "result" "CheckResult" NOT NULL,
    "note" TEXT,
    "ticketId" TEXT,
    "checkedById" TEXT,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunctionOverride" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "functionId" TEXT NOT NULL,
    "state" "CheckResult" NOT NULL,
    "reason" TEXT NOT NULL,
    "setById" TEXT,
    "setAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "FunctionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomCheck_roomId_functionId_checkedAt_idx" ON "RoomCheck"("roomId", "functionId", "checkedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RoomCheck_roundId_roomId_functionId_key" ON "RoomCheck"("roundId", "roomId", "functionId");

-- AddForeignKey
ALTER TABLE "Round" ADD CONSTRAINT "Round_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundRoom" ADD CONSTRAINT "RoundRoom_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundRoom" ADD CONSTRAINT "RoundRoom_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomCheck" ADD CONSTRAINT "RoomCheck_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomCheck" ADD CONSTRAINT "RoomCheck_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomCheck" ADD CONSTRAINT "RoomCheck_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "RoomFunction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomCheck" ADD CONSTRAINT "RoomCheck_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomCheck" ADD CONSTRAINT "RoomCheck_checkedById_fkey" FOREIGN KEY ("checkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunctionOverride" ADD CONSTRAINT "FunctionOverride_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunctionOverride" ADD CONSTRAINT "FunctionOverride_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "RoomFunction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunctionOverride" ADD CONSTRAINT "FunctionOverride_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


CREATE UNIQUE INDEX "function_override_open" ON "FunctionOverride" ("roomId", "functionId") WHERE "endedAt" IS NULL;
