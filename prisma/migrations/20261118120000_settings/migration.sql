CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB,
    "ciphertext" BYTEA,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "setting_one_value" CHECK (num_nonnulls("value", "ciphertext") = 1)
);
