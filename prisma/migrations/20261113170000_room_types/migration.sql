ALTER TABLE "Room" ADD COLUMN "roomTypeId" TEXT;

-- CreateTable
CREATE TABLE "RoomType" (
    "id" TEXT NOT NULL,
    "systemKey" TEXT,
    "name" TEXT NOT NULL,
    "renamed" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RoomType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomTypeFunction" (
    "typeId" TEXT NOT NULL,
    "functionId" TEXT NOT NULL,

    CONSTRAINT "RoomTypeFunction_pkey" PRIMARY KEY ("typeId","functionId")
);

-- CreateTable
CREATE TABLE "RoomFunctionExpectation" (
    "roomId" TEXT NOT NULL,
    "functionId" TEXT NOT NULL,
    "expected" BOOLEAN NOT NULL,
    "note" TEXT,

    CONSTRAINT "RoomFunctionExpectation_pkey" PRIMARY KEY ("roomId","functionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomType_systemKey_key" ON "RoomType"("systemKey");

-- CreateIndex
CREATE INDEX "RoomTypeFunction_functionId_idx" ON "RoomTypeFunction"("functionId");

-- CreateIndex
CREATE INDEX "RoomFunctionExpectation_functionId_idx" ON "RoomFunctionExpectation"("functionId");

-- CreateIndex
CREATE INDEX "Room_roomTypeId_idx" ON "Room"("roomTypeId");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomTypeFunction" ADD CONSTRAINT "RoomTypeFunction_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomTypeFunction" ADD CONSTRAINT "RoomTypeFunction_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "RoomFunction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomFunctionExpectation" ADD CONSTRAINT "RoomFunctionExpectation_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomFunctionExpectation" ADD CONSTRAINT "RoomFunctionExpectation_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "RoomFunction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
