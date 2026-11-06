-- CreateEnum
CREATE TYPE "MeetingFormat" AS ENUM ('in_person', 'online');

-- CreateEnum
CREATE TYPE "MeetingLanguage" AS ENUM ('en', 'it');

-- CreateEnum
CREATE TYPE "MeetingSource" AS ENUM ('recorded', 'uploaded', 'text');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('draft', 'recording', 'processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "ProcessingStage" AS ENUM ('preparing', 'transcribing');

-- CreateEnum
CREATE TYPE "SummaryStatus" AS ENUM ('generating', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "TurnStatus" AS ENUM ('pending', 'answered', 'failed');

-- CreateEnum
CREATE TYPE "TemplateScope" AS ENUM ('personal', 'shared');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('prepare_audio', 'transcribe', 'summarize', 'deliver_host_notice');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateEnum
CREATE TYPE "NoticeEvent" AS ENUM ('linked', 'changed', 'unlinked', 'deleted');

-- CreateEnum
CREATE TYPE "NoticePolicy" AS ENUM ('manual', 'until_delivered');

-- CreateEnum
CREATE TYPE "NoticeState" AS ENUM ('pending', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "meeting" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "format" "MeetingFormat" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "language" "MeetingLanguage" NOT NULL,
    "source" "MeetingSource" NOT NULL,
    "status" "MeetingStatus" NOT NULL DEFAULT 'draft',
    "stage" "ProcessingStage",
    "failureCode" TEXT,
    "noSpeech" BOOLEAN NOT NULL DEFAULT false,
    "creatorUserId" TEXT NOT NULL,
    "hostApp" TEXT,
    "hostEntityType" TEXT,
    "hostEntityId" TEXT,
    "hostVisible" BOOLEAN NOT NULL DEFAULT false,
    "hostNoticeSeq" INTEGER NOT NULL DEFAULT 0,
    "consentUserId" TEXT,
    "consentAt" TIMESTAMP(3),
    "consentNoticeVersion" TEXT,
    "durationMs" INTEGER,
    "audioKey" TEXT,
    "audioBytes" INTEGER,
    "audioCreatedAt" TIMESTAMP(3),
    "audioDeletedAt" TIMESTAMP(3),
    "processingRequestedBy" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "transcriptVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_session" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChunkAt" TIMESTAMP(3),
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "capturedMs" INTEGER,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "recording_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_chunk" (
    "meetingId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "sessionId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "storedAt" TIMESTAMP(3),

    CONSTRAINT "recording_chunk_pkey" PRIMARY KEY ("meetingId","seq")
);

-- CreateTable
CREATE TABLE "meeting_upload" (
    "meetingId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mintedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_upload_pkey" PRIMARY KEY ("meetingId")
);

-- CreateTable
CREATE TABLE "meeting_participant" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT,
    "externalName" TEXT,
    "externalOrganisation" TEXT,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segment" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "startMs" INTEGER,
    "endMs" INTEGER,
    "speakerKey" TEXT,
    "text" TEXT NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "transcript_segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "speaker_label" (
    "meetingId" TEXT NOT NULL,
    "speakerKey" TEXT NOT NULL,
    "participantId" TEXT,
    "customLabel" TEXT,

    CONSTRAINT "speaker_label_pkey" PRIMARY KEY ("meetingId","speakerKey")
);

-- CreateTable
CREATE TABLE "summary" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "template" JSONB NOT NULL,
    "language" "MeetingLanguage" NOT NULL,
    "status" "SummaryStatus" NOT NULL,
    "attemptId" TEXT NOT NULL,
    "failureCode" TEXT,
    "sections" JSONB,
    "transcriptVersion" INTEGER NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "summary_template" (
    "id" TEXT NOT NULL,
    "scope" "TemplateScope" NOT NULL,
    "ownerUserId" TEXT,
    "name" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "generalInstructions" TEXT,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "summary_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_turn" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" "TurnStatus" NOT NULL,
    "answer" JSONB,
    "failureCode" TEXT,
    "transcriptVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "conversation_turn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_request" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_job" (
    "id" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "meetingId" TEXT,
    "summaryId" TEXT,
    "noticeId" TEXT,
    "attemptId" TEXT,
    "state" "JobState" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_notice" (
    "id" TEXT NOT NULL,
    "hostApp" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "event" "NoticeEvent" NOT NULL,
    "title" TEXT,
    "startsAt" TIMESTAMP(3),
    "creatorUserId" TEXT NOT NULL,
    "policy" "NoticePolicy" NOT NULL,
    "state" "NoticeState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "host_notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_deletion" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "deletedByUserId" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_deletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_creatorUserId_startsAt_idx" ON "meeting"("creatorUserId", "startsAt" DESC);

-- CreateIndex
CREATE INDEX "meeting_hostApp_hostEntityType_hostEntityId_idx" ON "meeting"("hostApp", "hostEntityType", "hostEntityId");

-- CreateIndex
CREATE INDEX "recording_session_meetingId_idx" ON "recording_session"("meetingId");

-- CreateIndex
CREATE INDEX "recording_chunk_sessionId_idx" ON "recording_chunk"("sessionId");

-- CreateIndex
CREATE INDEX "meeting_participant_userId_idx" ON "meeting_participant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_participant_meetingId_userId_key" ON "meeting_participant"("meetingId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_segment_meetingId_ordinal_key" ON "transcript_segment"("meetingId", "ordinal");

-- CreateIndex
CREATE INDEX "summary_meetingId_createdAt_idx" ON "summary"("meetingId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_turn_meetingId_userId_createdAt_idx" ON "conversation_turn"("meetingId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_request_userId_at_idx" ON "ai_request"("userId", "at");

-- CreateIndex
CREATE INDEX "meeting_job_state_runAfter_idx" ON "meeting_job"("state", "runAfter");

-- CreateIndex
CREATE INDEX "host_notice_meetingId_idx" ON "host_notice"("meetingId");

-- AddForeignKey
ALTER TABLE "recording_session" ADD CONSTRAINT "recording_session_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_chunk" ADD CONSTRAINT "recording_chunk_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_chunk" ADD CONSTRAINT "recording_chunk_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "recording_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_upload" ADD CONSTRAINT "meeting_upload_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participant" ADD CONSTRAINT "meeting_participant_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segment" ADD CONSTRAINT "transcript_segment_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "speaker_label" ADD CONSTRAINT "speaker_label_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "speaker_label" ADD CONSTRAINT "speaker_label_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "meeting_participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "summary" ADD CONSTRAINT "summary_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turn" ADD CONSTRAINT "conversation_turn_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_job" ADD CONSTRAINT "meeting_job_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Enforcement the Prisma schema cannot express (specs/021 plan.md § Data model) ────

-- Host reference: all three members or none; hostVisible needs a host (AC-5.5).
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_host_all_or_none" CHECK (
  ("hostApp" IS NULL) = ("hostEntityType" IS NULL) AND ("hostApp" IS NULL) = ("hostEntityId" IS NULL)
);
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_host_visible_needs_host" CHECK (
  NOT "hostVisible" OR "hostApp" IS NOT NULL
);

-- Consent attestation: user, instant and notice version together or not at all (AC-4.3);
-- switching a draft to `text` clears it, so a text meeting never carries one (G1, AC-3.5).
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_consent_all_or_none" CHECK (
  ("consentUserId" IS NULL) = ("consentAt" IS NULL) AND ("consentUserId" IS NULL) = ("consentNoticeVersion" IS NULL)
);
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_no_consent_on_text" CHECK (
  "source" <> 'text' OR "consentUserId" IS NULL
);
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_title_length" CHECK (char_length("title") BETWEEN 1 AND 200);

-- A participant is exactly one of an Operai user or an external; only an external has an organisation (AC-5.1).
ALTER TABLE "meeting_participant" ADD CONSTRAINT "meeting_participant_kind_xor" CHECK (
  ("userId" IS NULL) <> ("externalName" IS NULL)
);
ALTER TABLE "meeting_participant" ADD CONSTRAINT "meeting_participant_external_org" CHECK (
  "userId" IS NULL OR "externalOrganisation" IS NULL
);
ALTER TABLE "meeting_participant" ADD CONSTRAINT "meeting_participant_external_lengths" CHECK (
  ("externalName" IS NULL OR char_length("externalName") BETWEEN 1 AND 100)
  AND ("externalOrganisation" IS NULL OR char_length("externalOrganisation") <= 100)
);

-- One live recording session per meeting: a second start is refused by the database itself.
CREATE UNIQUE INDEX "recording_session_live_key" ON "recording_session" ("meetingId") WHERE "endedAt" IS NULL;

-- Templates: an owner only on a personal one (AC-8.2); names unique among one's own personal
-- templates and, separately, among shared ones, case-insensitively (AC-8.2/8.3).
ALTER TABLE "summary_template" ADD CONSTRAINT "summary_template_owner_scope" CHECK (
  ("scope" = 'personal') = ("ownerUserId" IS NOT NULL)
);
ALTER TABLE "summary_template" ADD CONSTRAINT "summary_template_name_length" CHECK (char_length("name") BETWEEN 1 AND 80);
CREATE UNIQUE INDEX "summary_template_personal_name_key" ON "summary_template" ("ownerUserId", lower("name")) WHERE "scope" = 'personal';
CREATE UNIQUE INDEX "summary_template_shared_name_key" ON "summary_template" (lower("name")) WHERE "scope" = 'shared';

ALTER TABLE "conversation_turn" ADD CONSTRAINT "conversation_turn_question_length" CHECK (char_length("question") BETWEEN 1 AND 1000);

-- Tier-1 append-only record of deletions (ADR-0018 mechanism, AC-4.6): no UPDATE, no DELETE,
-- and no title column to leak. Test teardown uses TRUNCATE, which a row trigger does not block.
CREATE FUNCTION "meetings_append_only"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only and cannot be updated or deleted (id=%)', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "meeting_deletion_no_update" BEFORE UPDATE ON "meeting_deletion"
  FOR EACH ROW EXECUTE FUNCTION "meetings_append_only"();
CREATE TRIGGER "meeting_deletion_no_delete" BEFORE DELETE ON "meeting_deletion"
  FOR EACH ROW EXECUTE FUNCTION "meetings_append_only"();
