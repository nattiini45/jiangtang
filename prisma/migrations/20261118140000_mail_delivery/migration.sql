CREATE TABLE "MailDelivery" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "revision" TEXT,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reply" TEXT,
    "reason" TEXT,
    "payload" BYTEA,
    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MailDelivery_createdAt_idx" ON "MailDelivery"("createdAt");
CREATE INDEX "MailDelivery_kind_revision_status_idx" ON "MailDelivery"("kind", "revision", "status");
