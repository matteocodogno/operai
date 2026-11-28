# 20261124 — A duration a client reports is replaced by the one the server measures when they differ by more than the larger of 30 seconds and 10 %, decided once in the transaction that holds the measurement and before the meeting leaves `processing`

**Date:** 2026-11-24  
**Status:** Accepted (decided by the owner, 2026-11-24; ledger D63, D68, D69 in specs/20261112-time-tracking; plan D-P6 and D-P10 in specs/20261112-meeting-hours, approved the same day)  
**Deciders:** Owner of the Operai suite (wellD)  
**Project:** Operai

---

## Context

A Meetings recording is captured in the browser, which reports the length of each piece it stored, and the sum is the duration the meeting holds from Stop. For an upload, the container's own probed length is the held duration. Hours facts are built from that held duration (ADR 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older), so every automatic entry rests on it. The security review found that the reported figure is creator-controlled and never checked against the audio (`specs/20261112-meeting-hours/owasp-report.md`, L1), and that a decoded length differs from a reported one by ordinary noise (a timer, a header, a codec's padding).

## Decision

We will compare a held duration with the duration `prepare_audio` measures from the normalized audio, and replace the held one when the two differ by more than the larger of 30 seconds and 10 % of the held duration, shorter or longer; a held duration that is null takes the measured one, and a difference within that margin leaves the held duration as it is. The comparison is one pure integer function (`durationAfterMeasure`, planned in `meetings-api/src/media/measuredDuration.ts`), run inside `prepare_audio`'s step-3 commit (`meetings-api/src/jobs/handlers/prepareAudio.ts`, the `ctx.commit` at lines 254–270) with the held duration read under the meeting's row lock, and the correction never moves to `transcribe` or any later step, so the meeting's readers see it while it is still `processing`. A replaced duration is logged once for the operators (`[prepare_audio] duration_corrected`, meeting id and the two integers, no user id, no title) and is shown to no one.

## Failure shape

**What class of mistake does this prevent, stated so it's recognisable somewhere we haven't been yet?**
A figure one party reports and another party can check is accepted on the reporter's word, or it is overridden by the checker on any difference. Both decide on a threshold the two sides do not share, and the result is written where readers already act on it. The mistake is an unchecked claim becoming the record, or an approximate measurement silently replacing a claim that was right, or a late check that corrects a figure after everyone who reads it has moved on. A figure is wrong in both directions, longer and shorter, and the check must cover both.

Where else this shape can appear (the symmetric cases, which are the ones that get missed):
- **Both directions of the difference.** A claim too long and a claim too short are equally wrong; a check that only trusts a claim that is larger, or only corrects one that is smaller, has this shape.
- **Both directions of trust.** The checker overriding a claim is one side; the other is accepting a claim because the check could not run. "Could not measure" is not "measured and agreed": when the audio cannot be read the claim stands (ledger D69), and that is a residual to name, never a confirmation.
- **Read side and write side of the same figure.** Anything the server can recompute from bytes or inputs it already holds (a piece's stated length against its stored bytes, an upload's container length against its decoded audio, a stated size against the stored size) is the same figure seen from both ends. Check it where both exist, not where only one is.
- **Timing.** A correction written after the state readers watch has ended reaches nobody who already read the figure: open pages, copies built from it, and entries resized on a later read all keep the claim. Recognise it wherever a correction, or a derived copy of a figure, runs in a later job or after a "ready" state.
- **Refusal instead of correction.** Refusing the whole record on any disagreement looks safe but loses honest records to ordinary noise. Recognise it wherever a validation rejects an entity for a small disagreement on a value with a legitimate noise floor.
- **Inbound and outbound.** A corrected figure that another system copies must also be corrected there, through its owner's own versioned state; a copy that is only read and never corrected is the claim again.

## Options considered

### Option A — Replace when the difference exceeds the larger of 30 s and 10 %, decided in the measuring commit before `processing` ends (chosen)
The held duration is read under the row lock in the one commit that has the measurement; the rule is integers only (the difference times 10 compared with the held duration), two-sided, and the held duration stands within the margin.

**Pros:** honest noise never resizes an entry; a claim the audio contradicts beyond noise is corrected for every reader still watching the meeting; the rule is one pure function with two named constants, so it can be tuned in one line; the correction rides the existing hours notice, so no second notice path exists.
**Cons:** a correction resizes untouched entries silently (design G7); the margin is a judgement, not a measurement, and an honest recording with a systematic gap beyond it is corrected (R9); the overwritten held figure survives only in the operator log line.

### Option B — Always replace with the measured duration
**Rejected.** The measurement is itself noisy (A42): a timer, a header and the decoded audio differ by seconds on every honest recording, so every recording would resize its entries and re-announce them.

### Option C — Never replace; keep the creator's figure
**Rejected.** This is review L1: the claim stands even where the audio says otherwise, so a creator can state a longer meeting than its audio holds, and the entries of every participant follow the claim.

### Option D — Refuse the meeting when the two figures differ
**Rejected.** An honest glitch (an interrupted and resumed session, a codec's padding) would lose its whole meeting and its transcript, to protect a figure whose only effect is the length of an entry.

### Option E — Decide after `transcribe` or once the meeting is `ready`
**Rejected.** The page that is open stops polling at the first read that is not `processing` and keeps the held figure until the next visit (design G7, R10); copies built from the held figure would also be stale by then. The decision belongs where the measurement is in hand.

## Consequences

**Positive:**
- Entries are no longer resized by timer, header or codec noise (A42), so the automatic entries a person sees move only for a real difference.
- A claim that the audio contradicts beyond noise is corrected while the meeting is still `processing`, so an open Meetings page shows the measured figure on its next poll, and every entry built from the meeting follows it on its next read (AC-3.9).
- The rule is one pure function with two constants, testable on edge vectors without I/O.

**Negative / trade-offs:**
- A correction resizes untouched entries with no mark, note or notice; My hours does not refresh by itself (design G7, A43). This is accepted by the owner.
- The held figure is overwritten; it survives only in the `duration_corrected` log line (`heldMs`), not on the meeting or in any record.
- A held figure the audio cannot contradict stands: when the audio is unreadable the meeting fails and keeps its reported duration and the entries built on it (AC-3.10, D69). This is a residual of the creator-trust model (review L1), not a confirmed value.
- A meeting processed before this release is never measured, so the release backfill sends its held duration (R11, accepted: 14 days, creator-trusted before, each person can change or delete).

**Risks:**
- **R9 — the margin corrects honest recordings.** Mitigation: the `duration_corrected` line is the early signal (a pre-release check with a real recorder, an interrupted and resumed session, and an m4a and a webm upload is expected to log nothing); the margin is two constants in one function, and raising it is a one-line change decided with the owner.
- **R10 — a later change moves the correction after the meeting leaves `processing`.** Mitigation: the decision stays in `prepare_audio`'s commit, and the test for it asserts `status = processing` with the corrected duration after `prepare_audio` alone.
- **Implementation is pending.** When this ADR was written, `meetings-api/src/media/measuredDuration.ts` did not yet exist and the step-3 commit still wrote the duration only when it was null; the decision is accepted, the code is not. The tests named in plan § The measured duration (AC-3.8 unit and I-M tests) are the check that the decision is in the code.

## Compliance notes

- GDPR / data-protection impact: **low** — no new data is collected or sent. The log line holds the meeting id and two integers, never a user id or a title; the duration is the attendance-level fact already sent to hours-api under the earlier ADR. The correction does not expose the held value to any reader.
- Data residency: compliant with required jurisdiction — the measurement is an `ffprobe` of the normalized file inside meetings-api, on the existing EU deployment; no new hop, provider or outbound call.
- Audit trail: not required by this ADR. The `duration_corrected` operator log line is the only trace of a replaced value, by the owner's decision (D-P10); the held value is not otherwise kept.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*

Source: `specs/20261112-meeting-hours/plan.md` (§ The measured duration; D-P6, D-P10; § Risks R9–R11; § Security; § ADR candidates 4), `specs/20261112-meeting-hours/spec.md` (AC-3.8–AC-3.10, A42, A43), `specs/20261112-meeting-hours/design.md` (G7), `specs/20261112-meeting-hours/owasp-report.md` (L1), `specs/20261112-time-tracking/ledger.md` (D63, D68, D69). Code cited: `meetings-api/src/jobs/handlers/prepareAudio.ts`, `meetings-api/src/media/normalize.ts` (`normalizeAudio`, line 165), `meetings-api/src/hours/record.ts` (`recordHoursNotice`, the compare at line 113).
