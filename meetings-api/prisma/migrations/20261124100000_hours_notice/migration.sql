-- specs/20261112-meeting-hours (T8): the hours outbox, the meeting's hours version and the release backfill.
-- Plan § Data model "meetings-api" and § Release backfill; ADR
-- 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older.
--
-- Everything the schema diff lists, and only that: the raw-SQL objects the Prisma schema does not model
-- (meeting_folder_id_owner_key, meeting_folder_entry_owner_fkey) are left as they are.

-- CreateEnum
CREATE TYPE "HoursNoticeKind" AS ENUM ('state', 'deleted');

-- CreateEnum
CREATE TYPE "HoursNoticeState" AS ENUM ('pending', 'failed');

-- AlterEnum: `JobKind` gains `deliver_hours_notice`.
-- `ALTER TYPE ... ADD VALUE` is not used on purpose: a value added to an existing enum cannot be used in the
-- transaction that adds it ("unsafe use of new value"), and the backfill below inserts jobs of the new kind in this
-- same migration. The type is therefore replaced (what Prisma itself generates when it changes an enum other than
-- by appending): `meeting_job."kind"` is its only use, and the table is small.
ALTER TYPE "JobKind" RENAME TO "JobKind_old";
CREATE TYPE "JobKind" AS ENUM ('prepare_audio', 'transcribe', 'summarize', 'deliver_host_notice', 'deliver_hours_notice');
ALTER TABLE "meeting_job" ALTER COLUMN "kind" TYPE "JobKind" USING ("kind"::text::"JobKind");
DROP TYPE "JobKind_old";

-- AlterTable
ALTER TABLE "meeting" ADD COLUMN     "hoursSeq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "hours_notice" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "HoursNoticeKind" NOT NULL,
    "state" "HoursNoticeState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hours_notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hours_notice_meetingId_idx" ON "hours_notice"("meetingId");

-- ─── The release backfill (plan § Release backfill, R3) ──────────────────────────────────────────────────────────────
-- One notice (seq 1) and one until-delivered job for every meeting that already has a duration and started in the
-- last 14 days, and `hoursSeq` = 1 on it. Delivery builds the body from the meeting as it is then; hours-api drops what
-- is older than its own release day (`meeting_hours_release.since`). This covers the meetings processed on the release
-- day before meetings-api is deployed, and a gap of up to two weeks between the two services' deploys, with no
-- operator step. The job carries `noticeId` and no `meetingId`: it must outlive the meeting.
-- Every instant is written in UTC explicitly: these columns are `timestamp` without a zone, and a bare `now()` would be
-- taken in the session's zone.
WITH "due" AS (
    UPDATE "meeting"
       SET "hoursSeq" = 1
     WHERE "durationMs" > 0
       AND "startsAt" >= (now() AT TIME ZONE 'UTC') - interval '14 days'
    RETURNING "id"
), "notice" AS (
    INSERT INTO "hours_notice" ("id", "meetingId", "seq", "kind", "createdAt")
    SELECT gen_random_uuid()::text, "id", 1, 'state', (now() AT TIME ZONE 'UTC')
      FROM "due"
    RETURNING "id"
)
INSERT INTO "meeting_job" ("id", "kind", "noticeId", "state", "attempts", "maxAttempts", "runAfter", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'deliver_hours_notice', "id", 'queued', 0, 1000000,
       (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
  FROM "notice";
