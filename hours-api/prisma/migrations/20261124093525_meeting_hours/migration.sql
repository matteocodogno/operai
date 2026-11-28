-- Automatic entries for meetings (specs/20261112-meeting-hours T3, plan.md § Data model "hours-api",
-- ADR 20261124-a-system-written-time-entry-follows-its-source-fact-only-until-its-person-changes-it-and-is-never-written-again-after-the-person-removed-it).
-- The structure is Prisma's; the CHECKs, the partial unique index and the release row are raw SQL
-- (Prisma cannot express them), proved by src/db.constraints.test.ts and src/migration.seed.test.ts.
-- Existing rows get origin = person, no source meeting and followsMeeting = false, so every
-- existing CHECK of the initial migration still holds.

-- CreateEnum
CREATE TYPE "TimeEntryOrigin" AS ENUM ('person', 'meeting');

-- CreateEnum
CREATE TYPE "MeetingHoursBlockReason" AS ENUM ('had_entry', 'deleted');

-- AlterTable
ALTER TABLE "time_entry" ADD COLUMN     "origin" "TimeEntryOrigin" NOT NULL DEFAULT 'person',
ADD COLUMN     "sourceMeetingId" TEXT,
ADD COLUMN     "followsMeeting" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
-- The newest version of each meeting's facts applied (D-P1); the row is also the lock of an apply.
CREATE TABLE "meeting_hours_meeting" (
    "meetingId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL CHECK ("seq" >= 0),
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "meeting_hours_meeting_pkey" PRIMARY KEY ("meetingId")
);

-- CreateTable
-- A person who must never get an automatic entry on a meeting (AC-1.4, AC-2.5).
CREATE TABLE "meeting_hours_block" (
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" "MeetingHoursBlockReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_hours_block_pkey" PRIMARY KEY ("meetingId","userId")
);

-- CreateTable
-- The release day (AC-1.5): one row, written below, never by configuration.
CREATE TABLE "meeting_hours_release" (
    "id" SMALLINT NOT NULL CHECK ("id" = 1),
    "since" DATE NOT NULL,

    CONSTRAINT "meeting_hours_release_pkey" PRIMARY KEY ("id")
);

-- ─── CHECK constraints and the partial unique index (plan § Data model "hours-api") ──────────────

-- An automatic entry remembers its meeting, even once its person moved it elsewhere.
ALTER TABLE "time_entry"
  ADD CONSTRAINT "time_entry_origin_shape"
    CHECK (("origin" = 'meeting') = ("sourceMeetingId" IS NOT NULL));

-- Only an automatic entry still on its meeting, with no note, can follow it.
ALTER TABLE "time_entry"
  ADD CONSTRAINT "time_entry_follows_shape"
    CHECK (NOT "followsMeeting" OR ("origin" = 'meeting' AND "target" = 'meeting'
           AND "meetingId" = "sourceMeetingId" AND "note" IS NULL));

-- One automatic entry per meeting and person, ever (AC-4.2).
CREATE UNIQUE INDEX "time_entry_one_automatic_per_meeting"
  ON "time_entry" ("userId", "sourceMeetingId") WHERE "sourceMeetingId" IS NOT NULL;

-- ─── The release day (AC-1.5) ────────────────────────────────────────────────────────────────
-- The Europe/Zurich date the migration runs, the zone of both entities (A35), whatever the zone of
-- the session that applies it. Meetings of an earlier day record nothing.
INSERT INTO "meeting_hours_release" ("id", "since")
  VALUES (1, (now() AT TIME ZONE 'Europe/Zurich')::date);
