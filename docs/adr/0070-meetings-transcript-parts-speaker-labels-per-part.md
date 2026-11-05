# 0070 — A long recording is transcribed in parts, and speaker labels are numbered per part, never carried over

**Date:** 2026-11-05
**Status:** Accepted (specs/021-meetings; plan amendment "provider change: Google Cloud" approved by the user on 2026-11-05). Part size is confirmed by spike T107.
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0069](0069-meetings-ai-providers-google-cloud-eu.md), [ADR-0064](0064-meetings-api-reads-audio-bytes-third-reader.md), [ADR-0067](0067-ai-output-structured-validated-plain-text.md)

---

## Context

Google documents Chirp 3 batch recognition as good for audio "1 minute to 1 hour in general, but up to
20 minutes with word-level timestamp enabled", while meetings run to 3 h + 60 s. The recording is
therefore split into parts (default `PIECE_MAX_MS` = 60 min, cut in the longest silence of at least
0.5 s within the 90 s before the mark, stream copy with no re-encode), each transcribed as its own
request. Diarization labels are consistent only within one file, so nothing tells us whether part 2's
"speaker 1" is part 1's "speaker 1". Speaker names appear in the transcript, the download and every
summary built from it (AC-6.2).

## Decision

We will number speaker labels per part and never carry them across: the adapter emits
`speaker = "p<n>:<label>"`, the existing mapping numbers keys by first appearance across the whole
meeting (part 2's voices become "Speaker 4", "Speaker 5", ...), and the creator **merges by renaming**
two labels to the same participant or text, which the data model already allows. Part start offsets
are stored (`transcriptPartStartsMs`), `GET /meetings/:id/transcript` returns `parts`, and the UI shows
a non-blocking banner and a "Part n" divider only when there is more than one part.

## Failure shape

**A system asserting an identity relationship it cannot establish, where the assertion is then
consumed as fact downstream.** Two voices that merely share a label in two independent runs are not
known to be the same person. Treating them as one puts a person's words in another's mouth, and the
error does not stay in the transcript: every summary, citation and answer built from it repeats it
with full confidence. The costs are asymmetric: a false merge corrupts everything derived from it and
is invisible, while a false split costs one visible rename.

Mirror positions. **Merge and split:** prefer the error that is visible and cheap to repair over the
one that is silent. **Across parts, across meetings, across retries:** any place where independently
produced labels, ids or clusters are joined by position or ordinal (diarization of a second file,
speaker identity across two meetings, entity resolution across batches) has the same shape.
**Inference and biometrics:** the tempting fix, matching voices by embedding, is itself a new kind of
processing of personal data (biometric-adjacent) that the spec never asked for. Recognise it whenever
code equates two things because they sit at the same index.

## Options considered

### Option A (chosen) - Per-part labels, merge by renaming
**Pros:** never a false attribution; no new processing; no new endpoint (rename already merges); the code handles N >= 1 parts identically, so if the spike shows one 3 h file diarizes acceptably there is one part and nothing to stitch.
**Cons:** one person can appear under two labels on long meetings; the user sees a banner and part dividers.

### Option B - Carry labels across parts by ordinal
Rejected: part 2's "1" is not part 1's "1"; it would put one person's words in another's mouth in the transcript and every summary, which is worse than one person under two labels.

### Option C - Voice-embedding matching across parts
Rejected: new processing of voice characteristics (biometric-adjacent personal data) that the spec never asked for.

### Option D - Overlapping parts (about 2 min) and aligning the overlap's words
Not now. **Named follow-up.** Trigger: users routinely merging labels on long meetings.

### Option E - One whole-meeting request regardless of Google's guidance
The spike (T107) decides; the code allows it by raising `PIECE_MAX_MS` to the whole meeting.

## Consequences

**Positive:**
- No false attribution in transcripts or summaries.
- Merging reuses the existing rename path; the only API change is the additive `parts` field.

**Negative / trade-offs:**
- Long meetings show more speaker labels than people until renamed.
- A segment's times are at result granularity (never later than the speech) unless word offsets are enabled; part offsets come from the splitter's `parts.csv`.
- A retry re-runs all parts and replaces `transcriptPartStartsMs` (replace, never append); no per-part result is stored between attempts, since that would be a partial transcript at rest.

**Risks:**
- R20: label splits confuse readers and summaries. Mitigation: never-merge rule, banner, part dividers, merge by rename, possible removal of splitting by the spike, overlap alignment as follow-up. An AC-6.2 clarification for parts (plan A5) is the PO's to decide.

## Compliance notes

- GDPR / data-protection impact: low. No new data is processed; voice-embedding matching was rejected to avoid biometric-adjacent processing.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
