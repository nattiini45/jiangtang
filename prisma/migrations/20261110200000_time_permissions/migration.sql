CREATE TABLE "UserPermission" (
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("userId", "permission"),
    CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
