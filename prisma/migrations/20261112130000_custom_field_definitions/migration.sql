-- CreateEnum
CREATE TYPE "CustomFieldScope" AS ENUM ('ROOM', 'EQUIPMENT');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'BOOLEAN', 'CHOICE', 'MULTI_CHOICE', 'DATE', 'LINK');

-- CreateTable
CREATE TABLE "CustomField" (
    "id" TEXT NOT NULL,
    "scope" "CustomFieldScope" NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "helpText" TEXT,
    "section" TEXT,
    "type" "CustomFieldType" NOT NULL,
    "unit" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "showInList" BOOLEAN NOT NULL DEFAULT false,
    "listPosition" INTEGER,
    "searchable" BOOLEAN NOT NULL DEFAULT true,
    "systemKey" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CustomField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldKind" (
    "fieldId" TEXT NOT NULL,
    "kindId" TEXT NOT NULL,

    CONSTRAINT "CustomFieldKind_pkey" PRIMARY KEY ("fieldId","kindId")
);

-- CreateTable
CREATE TABLE "CustomFieldOption" (
    "id" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomFieldOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomField_systemKey_key" ON "CustomField"("systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "CustomField_scope_key_key" ON "CustomField"("scope", "key");

-- CreateIndex
CREATE INDEX "CustomFieldKind_kindId_idx" ON "CustomFieldKind"("kindId");

-- AddForeignKey
ALTER TABLE "CustomFieldKind" ADD CONSTRAINT "CustomFieldKind_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldKind" ADD CONSTRAINT "CustomFieldKind_kindId_fkey" FOREIGN KEY ("kindId") REFERENCES "EquipmentKind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldOption" ADD CONSTRAINT "CustomFieldOption_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "CustomField"
  ADD CONSTRAINT custom_field_key CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$'),
  ADD CONSTRAINT custom_field_name CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT custom_field_help CHECK (length("helpText") <= 300),
  ADD CONSTRAINT custom_field_section CHECK (length("section") <= 60),
  ADD CONSTRAINT custom_field_unit CHECK (length("unit") <= 12 AND ("unit" IS NULL OR "type" = 'NUMBER'));
ALTER TABLE "CustomFieldOption" ADD CONSTRAINT custom_field_option_label CHECK (length(btrim("label")) BETWEEN 1 AND 80);
CREATE UNIQUE INDEX custom_field_scope_name ON "CustomField" ("scope", lower("name"));
CREATE UNIQUE INDEX custom_field_option_active_label ON "CustomFieldOption" ("fieldId", lower("label")) WHERE "archivedAt" IS NULL;
