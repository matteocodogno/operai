# 0074 — A transcript that cannot be proven complete says where it may not be: detect, then mark (the retry is suspended, O15)

**Date:** 2026-11-05
**Status:** Accepted (specs/021-meetings; plan amendment #2 and spec A7 approved by the user on 2026-11-05); amended 2026-11-05 by spec A8: per-part retry suspended. Bounds are provisional until O14 (go-live gate).
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0070](0070-meetings-transcript-parts-speaker-labels-per-part.md), [ADR-0062](0062-durable-job-runner-work-queued-state-derived.md), [ADR-0067](0067-ai-output-structured-validated-plain-text.md), [ADR-0069](0069-meetings-ai-providers-google-cloud-eu.md), [ADR-0013](0013-invitation-lifecycle-derived-expiry-state.md)

---

## Context

The real-provider spike (T107) showed Chirp 3 silently omitting stretches of speech: at 18-19 min,
2 of 4 parts lost 19-45 % of their words; at 10 min some parts still lost 16-28 %. The provider
reports success and returns plausible text. Everything downstream (summaries, cited answers,
copies, decisions people take) reads the transcript as the complete record, so a silent omission
becomes a confident, wrong statement such as "the budget was not discussed".

## Decision

We will detect probable omissions and mark what remains, with the service writing the caveat.
The per-part retry originally decided here is **suspended** (see the Amendment of 2026-11-05).
Concretely:

- **Detect.** A pure detector compares each part's word timeline with the recording's sound
  intervals (speech-band energy, -35 dB). A stretch with at least 20 s of credited sound and no
  timed word is a **gap** (untimed words are credited 600 ms each; the provider's noise marker
  between a hole's bounding words excuses it by position). A repeated run of at least 8 words
  within 2 s is a **repetition**, removed on the chosen try only.
- **Retry within a bound (suspended by the 2026-11-05 amendment: tries = 1).** Up to 3 tries per part (2 retries), inside one job claim, held in
  memory only (ADR-0062); the best try is kept by a fixed ranking (fewest gaps, least gap time,
  no repetition, earlier try). Tries write no `ai_request`.
- **Mark.** The meeting stores its **final gaps** (after the neighbouring part's overlap has been
  credited) in `transcript_gap`, shown as a "possibly incomplete" notice with ranges, markers in
  place, and play controls while the audio exists. Every derived artefact carries a
  **service-written caveat**: a summary snapshots the gap ranges it was built under and renders the
  caveat itself, an answer carries `possiblyIncomplete`, copies include the label. The model is not
  told about gaps and does not write the caveat.
- **Nothing transcribed, gaps found:** an empty stitched transcript with a final gap is `failed`
  (`speech_not_transcribed`), never "no speech detected".

## Failure shape

**A silent omission being consumed downstream as a complete record.** The producer (a provider, a
parser, a sync, an importer) returns success for partial output; the consumer cannot tell "nothing
was said/there" from "it was not captured", so absence is read as fact, and every derivation
repeats it with full confidence. The check is possible only because a second, independent signal
exists (here, the audio's energy against the transcript's timeline).

Mirror positions. **Silence and error:** an empty result and a failed result must stay
distinguishable (the `noSpeech` / `speech_not_transcribed` split). **Producer and consumer:** the
marker must travel with the data to every consumer, written by the service, not left to a model or
to the UI of one screen (summary, answer, export, copy). **Forward and backward:** a summary built
before a gap was known, or regenerated later, must carry the gaps of the transcript it used. **Other
sources:** any pipeline where a counted total, a time range or a sibling record can be compared with
what arrived (a paginated read that returns fewer rows than a count, a sync that skips a window, a
batch that drops items) has the same shape. Recognise it wherever absence in a result is later
treated as meaning.

## Options considered

### Option A (chosen) - Detect, retry bounded, then mark
**Pros:** recovers most omissions (spike: about 1 part in 7); never claims completeness it cannot
prove; cost bounded (3 tries per part, about USD 0.16 per extra try); needs no new processing of
personal data beyond energy levels.
**Cons:** the energy detector can flag music or loud noise as a gap (the safe direction: a retry
and a notice); a marker emitted inside untranscribed speech would hide a gap (measured by O14).

### Option B - Re-transcribe the whole meeting on a gap
Rejected: cost (a 3 h meeting is about USD 3.40 per run) and it discards parts that were fine.

### Option C - A VAD or speech model of our own
Rejected: new processing and a new component; an energy bound suffices for a 20 s hole.

### Option D - Store per-part tries in Postgres to survive a crash
Rejected: it would put a partial transcript at rest (ADR-0070, ADR-0062); a lost claim starts over.

### Option E - Tell the model about the gaps
Rejected: the caveat becomes the model's prose, unreliable and open to injection (ADR-0067); the
service writes it.

### Option F - Hide gaps behind a setting
Rejected: an unmarked incomplete record is the failure itself.

### Option G (added by the amendment) - Blind retry of the same audio
Rejected: measured useless (8 of 8 retries byte-identical, about USD 1.4 for no gain).

### Option H (added by the amendment) - Drop detection together with the retry
Rejected: detection is what makes the omission visible; the marker does not depend on a retry.

## Consequences

**Positive:**
- A missing stretch is visible wherever the transcript or anything derived from it is read.
- Most omissions are repaired without the user noticing.

**Negative / trade-offs:**
- About +17 % billed audio (overlap) and up to 3x on a retried part; worst case about USD 10 per
  attempt for 3 h.
- More states to show and test (notice, markers, caveats, a new failure code).

**Risks:**
- False gaps or missed gaps: bounds are code constants, confirmed by O14 on consented recordings
  (go-live gate); the detector is pure and replay-tested.
- A caveat omitted from a new surface: every new consumer of a transcript must carry the gaps.

## Amendment 2026-11-05 (spec A8, after the T124 spike): the retry is suspended; detect and mark stand

**Evidence.** The real-sandbox run (115 min of synthetic audio, 3 runs) showed the provider is
deterministic: all 8 retries of flagged parts were byte-identical to try 1. Retrying the same
audio cost about USD 1.4 and improved nothing. 5 of 7 flagged parts were repetition-only, and the
repetition cleanup twice removed real speech of two different speakers saying the same words.

**What changes.**
- **Per-part retries are disabled: tries = 1.** The machinery (best-try ranking, per-try prefixes,
  in-memory holding inside one claim) is kept behind a single constant, so re-enabling is a
  constant change and not a rewrite. Gaps are marked exactly as before; the notice, the service
  written caveats and `speech_not_transcribed` are unchanged.
- **Trigger to revisit (O15).** Once production data exists, a retry may return only if it sends
  DIFFERENT audio (for example the part re-cut around the gap), because a retry of identical input
  has no reason to differ. Until then the suspension stands.
- **A repetition never flags a part.** It is cleaned on the single try but is no evidence of
  omission; only a gap (sound with no timed word) counts as probably incomplete.
- **Duplicate removal is same-speaker within a part.** Two passages inside one part are the same
  speech only when they carry the same speaker label (or one or both carry none). In the overlap
  of two consecutive parts, aligned passages meeting the word and time evidence are the same speech
  and are removed unless each label is joined (ADR-0070) to a different earlier label.
- **Untimed repeated tails are removed by content:** a tail with no word times that repeats the
  preceding text of the part by at least the repeat bound (8 consecutive words) is dropped, keeping
  any speech found in only one version.

**Rejected alternatives.** Blind same-audio retry (Option G): proven identical, pure cost. Dropping
detection (Option H): it would turn the suspension into the original failure shape, a silent omission.

**Failure shape, symmetric case.** A remedy applied without evidence it works is the mirror image of
no remedy: a retry loop that cannot change its input, or a cleanup that merges two sources because
their text matches, both claim a repair they have not shown. Recognise it wherever a fix is
validated by its own output; measure, and keep the marker either way.

**Consequences.** Cost per attempt falls back to the one-pass figure (about +17 % overlap only).
Gaps that a retry might have repaired now show as notices; the marker, not the retry, is what keeps
the record honest. Bounds stay provisional until O14.

## Compliance notes

- GDPR / data-protection impact: low. The detector uses sound energy and word times, no voice
  characteristics; each retry leaves the provider one more result under the ~5-day bound disclosed
  in ADR-0069 (sign-off H4).
- Audit trail: logs hold sizes and counts only (AC-4.10); gaps are deleted with the meeting.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
