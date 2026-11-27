-- specs/20261126-teams T1 — `team` and `team_member`. Purely additive. A team grants nothing: the permission
-- resolver never reads these tables (AC-2.5).

-- CreateTable
CREATE TABLE "team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_member" (
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedByUserId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_member_pkey" PRIMARY KEY ("teamId","userId")
);

-- CreateIndex
CREATE INDEX "team_member_userId_idx" ON "team_member"("userId");

-- AddForeignKey
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What Prisma cannot express. The unique index on lower("name") decides a name clash, archived teams included
-- (AC-1.2); the CHECKs keep the database never looser than the API (it trims and counts UTF-16 units, which
-- are never fewer than char_length).
CREATE UNIQUE INDEX "team_name_lower_key" ON "team" (lower("name"));

ALTER TABLE "team" ADD CONSTRAINT "team_name_shape"
  CHECK (char_length("name") BETWEEN 1 AND 80 AND "name" = btrim("name"));

ALTER TABLE "team" ADD CONSTRAINT "team_description_shape"
  CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 500);
