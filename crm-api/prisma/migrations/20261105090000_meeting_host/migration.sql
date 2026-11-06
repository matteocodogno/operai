-- specs/021 US-14 (ADR-0059): the CRM mirrors a Meetings meeting as one `meeting` activity.

-- AlterTable
ALTER TABLE "activity" ADD COLUMN "meetingId" TEXT;

-- CreateIndex: at most one activity per meeting, across duplicates and retries (AC-14.9)
CREATE UNIQUE INDEX "activity_meetingId_key" ON "activity"("meetingId");

-- Only a `meeting` activity can mirror a meeting.
ALTER TABLE "activity"
  ADD CONSTRAINT "activity_meeting_id_only_on_meetings" CHECK ("meetingId" IS NULL OR "type" = 'meeting');

-- CreateTable: content-free ordering guard + tombstone per meeting
CREATE TABLE "meeting_host_state" (
    "meetingId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_host_state_pkey" PRIMARY KEY ("meetingId")
);
