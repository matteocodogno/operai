-- specs/20261126-teams (T11): the teams attached to a project. Only the id of an `auth` team is kept: its name,
-- archived state and members are read live from auth (AC-1.3), so this table has no name column. Purely additive.

-- CreateTable
CREATE TABLE "project_attached_team" (
    "projectId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_attached_team_pkey" PRIMARY KEY ("projectId","teamId")
);

-- CreateIndex
CREATE INDEX "project_attached_team_teamId_idx" ON "project_attached_team"("teamId");

-- AddForeignKey
ALTER TABLE "project_attached_team" ADD CONSTRAINT "project_attached_team_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A team id is an opaque auth id: 1..64 characters (as `IdSchema`). No NUL check: a Postgres text value cannot
-- hold a NUL, and writing one with the chr function is itself an error.
ALTER TABLE "project_attached_team" ADD CONSTRAINT "attached_team_id_shape"
  CHECK (char_length("teamId") BETWEEN 1 AND 64);
