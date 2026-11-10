CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "tokenHash" CHAR(64),
    "invitedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DO $$
DECLARE
    row RECORD;
    payload JSONB;
BEGIN
    FOR row IN SELECT * FROM "Verification" LOOP
        BEGIN
            payload := row.value::jsonb;
        EXCEPTION WHEN invalid_text_representation THEN
            CONTINUE;
        END;
        IF jsonb_typeof(payload->'token') = 'string'
           AND jsonb_typeof(payload->'email') = 'string'
           AND jsonb_typeof(payload->'initials') = 'string'
           AND payload->>'role' IN ('ADMIN', 'MEMBER') THEN
            INSERT INTO "Invitation" (
                "id", "email", "name", "initials", "role", "tokenHash",
                "invitedById", "createdAt", "expiresAt"
            ) VALUES (
                row.id, lower(payload->>'email'), coalesce(payload->>'name', ''),
                payload->>'initials', (payload->>'role')::"UserRole",
                encode(sha256(convert_to(payload->>'token', 'UTF8')), 'hex'),
                (SELECT u.id FROM "ActivityLog" a JOIN "User" u ON u.id = a."actorId"
                 WHERE a.action = 'UserInvited' AND lower(a."entityId") = lower(row.identifier)
                 ORDER BY a."occurredAt" DESC LIMIT 1),
                row."createdAt", row."expiresAt"
            );
        END IF;
    END LOOP;
END $$;
