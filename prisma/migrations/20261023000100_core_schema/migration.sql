-- Functional baseline, file 2 of 7: core schema - enums, tables, foreign keys
-- and modeled indexes.
--
-- Responsibility: define the baseline's enum types, its tables, and the
-- foreign keys and modeled indexes those tables carry, exactly as the
-- reference installation holds them: type and column names, live column order
-- (ordinal position 1..n), types with precision and scale, nullability
-- including array columns, the defaults the database actually carries, the
-- measured referential actions, and each index's uniqueness, columns and
-- access method.
--
-- The file is written in three passes:
--   * the enums, then every table in domain order, each table carrying only
--     the PRIMARY KEY and the NOT NULL constraints. Database defaults are
--     written only where the reference catalog records one; a Prisma-level
--     @default(cuid()) or @updatedAt is not a database default and is
--     therefore not emitted;
--   * all 53 FOREIGN KEY constraints, added after every table exists, so that
--     mutually referencing tables (Equipment self-reference, Location tree,
--     Project parent chain, Task<->Ticket) can be declared in any order;
--   * the 72 modeled secondary and unique indexes, 19 of them unique, created
--     after the constraints.
--
-- Not in this file, by ownership: generated columns, exclusion constraints,
-- triggers, functions, views, row data and privileges - those live in their
-- own baseline files.
--
-- Enum labels are written in the measured order, one CREATE TYPE each. Two
-- labels are the final post-history spelling and are created directly:
-- TaskStatus uses 'CANCELLED' (the historical single-L label was renamed) and
-- ProjectStatus carries the eight-label vocabulary. No obsolete conversion,
-- rename, drop or recreate step is reproduced.

-- ===========================================================================
-- Enums
-- ===========================================================================

CREATE TYPE "AttachmentCategory" AS ENUM ('ROOM', 'CONTROL_PANEL', 'CONNECTION_PANEL', 'EQUIPMENT', 'TICKET');

CREATE TYPE "CalendarOp" AS ENUM ('UPSERT', 'REMOVE');

CREATE TYPE "EquipmentCategory" AS ENUM ('PROJECTOR', 'PC', 'MICROPHONE', 'MEDIA_CONTROL', 'AUDIO', 'RECORDER', 'SMARTBOARD', 'REMOTE', 'SWITCHER', 'OTHER');

CREATE TYPE "EquipmentMobility" AS ENUM ('FIXED', 'POOLED');

CREATE TYPE "EquipmentStatus" AS ENUM ('OPERATIONAL', 'FAULTY', 'MAINTENANCE', 'RETIRED');

CREATE TYPE "EventStatus" AS ENUM ('PLANNED', 'CONFIRMED', 'IN_PROGRESS', 'DONE', 'CANCELLED');

CREATE TYPE "LocationKind" AS ENUM ('SITE', 'BUILDING', 'ROOM', 'STORAGE', 'RACK', 'VEHICLE', 'EXTERNAL', 'VIRTUAL');

CREATE TYPE "MicKind" AS ENUM ('HANDHELD', 'BODYPACK', 'GOOSENECK');

CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TYPE "ProjectStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'AWAITING_FEEDBACK', 'CONSULTATION_SCHEDULED', 'COMPLETED', 'FOLLOW_UP_REQUIRED', 'REJECTED', 'CANCELLED');

CREATE TYPE "RoomStatus" AS ENUM ('ALL_GOOD', 'PROVISIONAL', 'MAINTENANCE_NEEDED', 'TECH_DEFECT', 'OUT_OF_SERVICE');

CREATE TYPE "ServiceWindowKind" AS ENUM ('SETUP', 'STANDBY', 'TEARDOWN');

CREATE TYPE "StockStatus" AS ENUM ('AVAILABLE', 'REQUESTED', 'AWAITING_CONFIRMATION', 'ON_LOAN', 'RESERVED_FOR_EVENT');

CREATE TYPE "TaskPriority" AS ENUM ('LOWEST', 'LOW', 'MEDIUM', 'HIGH', 'URGENT');

CREATE TYPE "TaskStatus" AS ENUM ('BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELLED');

CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');

CREATE TYPE "TicketType" AS ENUM ('INCIDENT', 'REQUEST', 'REPAIR');

CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MEMBER');

-- ===========================================================================
-- Identity
-- ===========================================================================

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER'::"UserRole",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "weeklyCapacityMinutes" INTEGER,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Locations
-- ===========================================================================

CREATE TABLE "Campus" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Building" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,

    CONSTRAINT "Building_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "kind" "LocationKind" NOT NULL,
    "address" TEXT,
    "description" TEXT,
    "parentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roomNumber" TEXT,
    "campusId" TEXT,
    "buildingId" TEXT,
    "capacity" INTEGER,
    "owner" TEXT,
    "status" "RoomStatus" NOT NULL DEFAULT 'ALL_GOOD'::"RoomStatus",
    "hasProjector" BOOLEAN NOT NULL DEFAULT false,
    "hasMicrophony" BOOLEAN NOT NULL DEFAULT false,
    "hasBlackboard" BOOLEAN NOT NULL DEFAULT false,
    "hasWebConference" BOOLEAN NOT NULL DEFAULT false,
    "hasAutoRecording" BOOLEAN NOT NULL DEFAULT false,
    "mediaKeyRequired" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckedAt" TIMESTAMPTZ(3),
    "videoInputs" TEXT[],
    "audioOutputs" TEXT[],
    "bookingUrl" TEXT,
    "manualUrl" TEXT,
    "virtualTourUrl" TEXT,
    "tipsNotes" TEXT,
    "renewalStatus" TEXT,
    "renewalFrom" TIMESTAMPTZ(3),
    "renewalTo" TIMESTAMPTZ(3),
    "notionPageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Inventory
-- ===========================================================================

CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "url" TEXT,
    "address" TEXT,
    "locationId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "serial" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit" TEXT,
    "category" TEXT,
    "status" "StockStatus",
    "purchasedAt" TIMESTAMPTZ(3),
    "purchasePrice" DECIMAL(10,2),
    "warrantyExpiresAt" TIMESTAMPTZ(3),
    "vendorId" TEXT,
    "locationId" TEXT,
    "equipmentId" TEXT,
    "tags" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EquipmentModel" (
    "id" TEXT NOT NULL,
    "manufacturer" TEXT,
    "name" TEXT NOT NULL,
    "category" "EquipmentCategory" NOT NULL,
    "specNotes" TEXT,
    "manualUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EquipmentModel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL,
    "roomId" TEXT,
    "modelId" TEXT,
    "category" "EquipmentCategory" NOT NULL,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'OPERATIONAL'::"EquipmentStatus",
    "mobility" "EquipmentMobility" NOT NULL DEFAULT 'FIXED'::"EquipmentMobility",
    "name" TEXT,
    "assetTag" TEXT,
    "serial" TEXT,
    "lastCheckedAt" TIMESTAMPTZ(3),
    "substitutingForId" TEXT,
    "hostname" TEXT,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "dellServiceTag" TEXT,
    "dellExpressTag" TEXT,
    "micKind" "MicKind",
    "frequencyMhz" DECIMAL(8,3),
    "band" TEXT,
    "channelLabel" TEXT,
    "lampType" TEXT,
    "lastLampChangeAt" TIMESTAMPTZ(3),
    "color" TEXT,
    "attributes" JSONB,
    "notionPageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Work
-- ===========================================================================

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'REQUESTED'::"ProjectStatus",
    "color" TEXT,
    "startAt" TIMESTAMPTZ(3),
    "dueAt" TIMESTAMPTZ(3),
    "leadId" TEXT,
    "parentProjectId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'BACKLOG'::"TaskStatus",
    "priority" "TaskPriority",
    "startAt" TIMESTAMPTZ(3),
    "dueAt" TIMESTAMPTZ(3),
    "estimateMinutes" INTEGER,
    "position" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "labels" TEXT[],
    "projectId" TEXT,
    "ticketId" TEXT,
    "parentTaskId" TEXT,
    "locationId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "type" "TicketType" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN'::"TicketStatus",
    "title" TEXT NOT NULL,
    "description" TEXT,
    "resolution" TEXT,
    "priority" INTEGER,
    "roomId" TEXT,
    "equipmentId" TEXT,
    "eventId" TEXT,
    "reporterId" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "notionSource" TEXT,
    "insertedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "taskId" TEXT,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskAssignees" (
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "estimateMinutes" INTEGER,

    CONSTRAINT "TaskAssignees_pkey" PRIMARY KEY ("taskId", "userId")
);

CREATE TABLE "TaskDependency" (
    "blockedByTaskId" TEXT NOT NULL,
    "blockingTaskId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("blockedByTaskId", "blockingTaskId")
);

CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "authorId" TEXT NOT NULL,
    "projectId" TEXT,
    "locationId" TEXT,
    "tags" TEXT[],
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "category" "AttachmentCategory" NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "roomId" TEXT,
    "equipmentId" TEXT,
    "ticketId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorSnapshot" JSONB,
    "data" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "insertedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Events
-- ===========================================================================

CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'PLANNED'::"EventStatus",
    "organizer" TEXT,
    "contact" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "projectId" TEXT,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CalendarOutbox" (
    "id" TEXT NOT NULL,
    "op" "CalendarOp" NOT NULL,
    "eventUid" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING'::"OutboxStatus",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CalendarOutbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventRoomBooking" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRoomBooking_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EquipmentAllocation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServiceWindow" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roomId" TEXT,
    "kind" "ServiceWindowKind" NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "coveringUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceWindow_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Search
-- ===========================================================================

CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "headingPath" TEXT[],
    "text" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT ''::text,
    "tokenCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1024),
    "embeddingModel" TEXT,
    "sourceUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SearchIndexJob" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SearchIndexJob_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Time
-- ===========================================================================

CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3),
    "comment" TEXT,
    "taskId" TEXT,
    "userId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Implicit join table
-- ===========================================================================

CREATE TABLE "_Assignees" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_Assignees_AB_pkey" PRIMARY KEY ("A", "B")
);

-- ===========================================================================
-- Foreign keys
-- ===========================================================================
--
-- All 53 foreign keys are added here, after every table exists, so the cyclic
-- relationships (Equipment self-reference, Location tree, Project parent chain,
-- Task<->Ticket) impose no declaration order on the table definitions above.
--
-- Measured state of every one of the 53: VALID, NOT DEFERRABLE (INITIALLY
-- IMMEDIATE), MATCH SIMPLE, referencing a column in schema public. Nothing is
-- written NOT VALID and nothing is written DEFERRABLE, because the reference
-- installation holds no such constraint.
--
-- ON DELETE / ON UPDATE are the measured values, not the schema's intuitive
-- ones: six FKs carry RESTRICT where an intuitive reading would expect CASCADE
-- or SET NULL, and Attachment's three references are RESTRICT as well. The
-- measured action is written directly; no earlier definition and no DROP/ADD
-- pair is reproduced.


-- Identity
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Locations
ALTER TABLE "Building" ADD CONSTRAINT "Building_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Location" ADD CONSTRAINT "Location_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Location" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Room" ADD CONSTRAINT "Room_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Room" ADD CONSTRAINT "Room_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Inventory
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "EquipmentModel" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_substitutingForId_fkey" FOREIGN KEY ("substitutingForId") REFERENCES "Equipment" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Work
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_parentProjectId_fkey" FOREIGN KEY ("parentProjectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskAssignees" ADD CONSTRAINT "TaskAssignees_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignees" ADD CONSTRAINT "TaskAssignees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_blockedByTaskId_fkey" FOREIGN KEY ("blockedByTaskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_blockingTaskId_fkey" FOREIGN KEY ("blockingTaskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Events
ALTER TABLE "EquipmentAllocation" ADD CONSTRAINT "EquipmentAllocation_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EquipmentAllocation" ADD CONSTRAINT "EquipmentAllocation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventRoomBooking" ADD CONSTRAINT "EventRoomBooking_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventRoomBooking" ADD CONSTRAINT "EventRoomBooking_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceWindow" ADD CONSTRAINT "ServiceWindow_coveringUserId_fkey" FOREIGN KEY ("coveringUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceWindow" ADD CONSTRAINT "ServiceWindow_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceWindow" ADD CONSTRAINT "ServiceWindow_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Time
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Implicit join table
ALTER TABLE "_Assignees" ADD CONSTRAINT "_Assignees_A_fkey" FOREIGN KEY ("A") REFERENCES "Ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_Assignees" ADD CONSTRAINT "_Assignees_B_fkey" FOREIGN KEY ("B") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Modeled secondary indexes
-- ===========================================================================
--
-- 72 indexes: 19 UNIQUE (Prisma's @unique / @@unique are unique indexes in this
-- database, not table constraints - the catalog records unique_constraints 0
-- and unique_indexes 20, and one of those 20, time_entry_one_running_per_user,
-- is a package 2e object) plus 53 ordinary lookup indexes.
--
-- Every one is btree with the type-default operator class, no INCLUDE columns,
-- no WITH options, no tablespace and no WHERE predicate, so no opclass, storage
-- or predicate clause is emitted: writing an explicit default opclass would
-- describe the same index in a way the catalog does not.
--
-- Not here, by ownership: the 31 primary-key indexes (created by the PRIMARY KEY
-- clauses above), the 2 GiST EXCLUDE constraints and the 4 Chunk search indexes
-- (2d), and time_entry_one_running_per_user (2e).


-- Identity
CREATE INDEX "Account_userId_idx" ON "Account" USING btree ("userId");
CREATE UNIQUE INDEX "Session_token_key" ON "Session" USING btree ("token");
CREATE INDEX "Session_userId_idx" ON "Session" USING btree ("userId");
CREATE UNIQUE INDEX "User_email_key" ON "User" USING btree ("email");
CREATE UNIQUE INDEX "User_initials_key" ON "User" USING btree ("initials");
CREATE INDEX "Verification_identifier_idx" ON "Verification" USING btree ("identifier");

-- Locations
CREATE UNIQUE INDEX "Building_campusId_name_key" ON "Building" USING btree ("campusId", "name");
CREATE UNIQUE INDEX "Campus_name_key" ON "Campus" USING btree ("name");
CREATE UNIQUE INDEX "Campus_slug_key" ON "Campus" USING btree ("slug");
CREATE INDEX "Location_kind_idx" ON "Location" USING btree ("kind");
CREATE INDEX "Location_parentId_idx" ON "Location" USING btree ("parentId");
CREATE INDEX "Room_campusId_idx" ON "Room" USING btree ("campusId");
CREATE UNIQUE INDEX "Room_notionPageId_key" ON "Room" USING btree ("notionPageId");
CREATE UNIQUE INDEX "Room_slug_key" ON "Room" USING btree ("slug");
CREATE INDEX "Room_status_idx" ON "Room" USING btree ("status");

-- Inventory
CREATE UNIQUE INDEX "EquipmentModel_manufacturer_name_key" ON "EquipmentModel" USING btree ("manufacturer", "name");
CREATE INDEX "Equipment_category_idx" ON "Equipment" USING btree ("category");
CREATE INDEX "Equipment_modelId_idx" ON "Equipment" USING btree ("modelId");
CREATE UNIQUE INDEX "Equipment_notionPageId_key" ON "Equipment" USING btree ("notionPageId");
CREATE INDEX "Equipment_roomId_idx" ON "Equipment" USING btree ("roomId");
CREATE INDEX "Equipment_status_idx" ON "Equipment" USING btree ("status");
CREATE UNIQUE INDEX "Equipment_substitutingForId_key" ON "Equipment" USING btree ("substitutingForId");
CREATE INDEX "InventoryItem_equipmentId_idx" ON "InventoryItem" USING btree ("equipmentId");
CREATE INDEX "InventoryItem_locationId_idx" ON "InventoryItem" USING btree ("locationId");
CREATE UNIQUE INDEX "InventoryItem_serial_key" ON "InventoryItem" USING btree ("serial");
CREATE UNIQUE INDEX "InventoryItem_sku_key" ON "InventoryItem" USING btree ("sku");
CREATE INDEX "InventoryItem_vendorId_idx" ON "InventoryItem" USING btree ("vendorId");
CREATE INDEX "Vendor_locationId_idx" ON "Vendor" USING btree ("locationId");

-- Work
CREATE INDEX "ActivityLog_entityType_entityId_idx" ON "ActivityLog" USING btree ("entityType", "entityId");
CREATE INDEX "ActivityLog_occurredAt_idx" ON "ActivityLog" USING btree ("occurredAt");
CREATE INDEX "Attachment_equipmentId_idx" ON "Attachment" USING btree ("equipmentId");
CREATE UNIQUE INDEX "Attachment_objectKey_key" ON "Attachment" USING btree ("objectKey");
CREATE INDEX "Attachment_roomId_idx" ON "Attachment" USING btree ("roomId");
CREATE INDEX "Attachment_ticketId_idx" ON "Attachment" USING btree ("ticketId");
CREATE INDEX "Note_archivedAt_idx" ON "Note" USING btree ("archivedAt");
CREATE INDEX "Note_authorId_idx" ON "Note" USING btree ("authorId");
CREATE INDEX "Note_locationId_idx" ON "Note" USING btree ("locationId");
CREATE INDEX "Note_projectId_idx" ON "Note" USING btree ("projectId");
CREATE INDEX "Project_leadId_idx" ON "Project" USING btree ("leadId");
CREATE INDEX "Project_parentProjectId_idx" ON "Project" USING btree ("parentProjectId");
CREATE UNIQUE INDEX "Project_slug_key" ON "Project" USING btree ("slug");
CREATE INDEX "Project_status_idx" ON "Project" USING btree ("status");
CREATE INDEX "TaskAssignees_userId_idx" ON "TaskAssignees" USING btree ("userId");
CREATE INDEX "TaskDependency_blockingTaskId_idx" ON "TaskDependency" USING btree ("blockingTaskId");
CREATE INDEX "Task_dueAt_idx" ON "Task" USING btree ("dueAt");
CREATE INDEX "Task_locationId_idx" ON "Task" USING btree ("locationId");
CREATE INDEX "Task_parentTaskId_idx" ON "Task" USING btree ("parentTaskId");
CREATE INDEX "Task_projectId_idx" ON "Task" USING btree ("projectId");
CREATE INDEX "Task_status_idx" ON "Task" USING btree ("status");
CREATE INDEX "Task_ticketId_idx" ON "Task" USING btree ("ticketId");
CREATE INDEX "Ticket_equipmentId_idx" ON "Ticket" USING btree ("equipmentId");
CREATE INDEX "Ticket_occurredAt_idx" ON "Ticket" USING btree ("occurredAt");
CREATE INDEX "Ticket_roomId_idx" ON "Ticket" USING btree ("roomId");
CREATE INDEX "Ticket_status_idx" ON "Ticket" USING btree ("status");
CREATE INDEX "Ticket_type_idx" ON "Ticket" USING btree ("type");

-- Events
CREATE UNIQUE INDEX "CalendarOutbox_eventUid_sequence_key" ON "CalendarOutbox" USING btree ("eventUid", "sequence");
CREATE INDEX "CalendarOutbox_status_createdAt_idx" ON "CalendarOutbox" USING btree ("status", "createdAt");
CREATE INDEX "EquipmentAllocation_equipmentId_idx" ON "EquipmentAllocation" USING btree ("equipmentId");
CREATE INDEX "EquipmentAllocation_eventId_idx" ON "EquipmentAllocation" USING btree ("eventId");
CREATE INDEX "EventRoomBooking_eventId_idx" ON "EventRoomBooking" USING btree ("eventId");
CREATE INDEX "EventRoomBooking_roomId_idx" ON "EventRoomBooking" USING btree ("roomId");
CREATE INDEX "Event_startsAt_idx" ON "Event" USING btree ("startsAt");
CREATE INDEX "Event_status_idx" ON "Event" USING btree ("status");
CREATE UNIQUE INDEX "Event_uid_key" ON "Event" USING btree ("uid");
CREATE INDEX "ServiceWindow_eventId_idx" ON "ServiceWindow" USING btree ("eventId");

-- Search
CREATE INDEX "Chunk_sourceType_sourceId_idx" ON "Chunk" USING btree ("sourceType", "sourceId");
CREATE UNIQUE INDEX "Chunk_sourceType_sourceId_ordinal_key" ON "Chunk" USING btree ("sourceType", "sourceId", "ordinal");
CREATE INDEX "SearchIndexJob_nextAttemptAt_idx" ON "SearchIndexJob" USING btree ("nextAttemptAt");
CREATE UNIQUE INDEX "SearchIndexJob_sourceType_sourceId_op_key" ON "SearchIndexJob" USING btree ("sourceType", "sourceId", "op");

-- Time
CREATE INDEX "TimeEntry_taskId_idx" ON "TimeEntry" USING btree ("taskId");
CREATE INDEX "TimeEntry_userId_startsAt_idx" ON "TimeEntry" USING btree ("userId", "startsAt");

-- Implicit join table
CREATE INDEX "_Assignees_B_index" ON "_Assignees" USING btree ("B");
