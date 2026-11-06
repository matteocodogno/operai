-- ADR-0070: a long recording is transcribed in parts. `transcriptPartStartsMs` holds where each part starts
-- (ms from the start of the recording): [0] for one part, [0, t2, ...] for several, {} for a `text` meeting
-- and for `noSpeech`. Additive; existing rows read as no parts.
ALTER TABLE "meeting" ADD COLUMN "transcriptPartStartsMs" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
