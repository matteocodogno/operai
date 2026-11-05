-- specs/021-meetings plan § Amendment 2026-11-05 #2, H-5 (AC-6.2, AC-6.7, AC-6.12, AC-6.15, AC-6.16, AC-7.13).
-- Additive only: every existing row keeps reading as before (no part ends, no segment part, no gap, no snapshot).

-- The parts overlap now, so each carries its end beside its start.
ALTER TABLE "meeting" ADD COLUMN "transcriptPartEndsMs" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

-- Which part a segment comes from: the joined label's coverage, "Separate by part", the dividers.
ALTER TABLE "transcript_segment" ADD COLUMN "part" INTEGER;

-- A separated label that inherits an unnamed "Speaker n".
ALTER TABLE "speaker_label" ADD COLUMN "defaultIndex" INTEGER;

-- The ranges a summary was made under.
ALTER TABLE "summary" ADD COLUMN "transcriptGaps" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "transcript_gap" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,

    CONSTRAINT "transcript_gap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transcript_gap_meetingId_startMs_idx" ON "transcript_gap"("meetingId", "startMs");

-- AddForeignKey
ALTER TABLE "transcript_gap" ADD CONSTRAINT "transcript_gap_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
