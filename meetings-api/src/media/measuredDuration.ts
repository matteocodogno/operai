/**
 * The duration a recorded or uploaded meeting holds once `prepare_audio` has measured its audio (specs/20261112-meeting-hours
 * AC-3.8, AC-3.10; plan § The measured duration, D-P6; ADR
 * 20261124-a-duration-a-client-reports-is-replaced-by-the-one-the-server-measures-when-they-differ-by-more-than-the-larger-of-30-seconds-and-10-percent).
 *
 * The held duration is what the creator's browser reported (a recording: the sum of the stored pieces) or what the uploaded
 * file's own container says; every automatic entry of every participant is built from it. The measured one is the length of
 * the decoded, normalized audio (`normalizeAudio`'s ffprobe). They differ by ordinary noise on every honest recording (a timer,
 * a header, a codec's padding), so the measurement does not simply win: it replaces the held figure only when the two differ by
 * more than the larger of 30 seconds and 10 % of the held duration, in either direction (A42).
 *
 * Pure, no I/O, integers only: a float percentage would make an edge vector depend on rounding.
 */

/** The smallest difference that is material, whatever the held duration: 30 s (A42). */
export const MEASURE_MARGIN_FLOOR_MS = 30_000;
/** A difference must also exceed held / 10, i.e. 10 % (A42), compared as `difference × 10 > held`: no float. */
export const MEASURE_MARGIN_DIVISOR = 10;

/**
 * The duration a recorded or uploaded meeting holds once its audio has been measured.
 *   held null                                   → measured (no duration yet: today's rule, AC-1.1)
 *   |measured − held| > max(30 s, held × 10 %)  → measured (AC-3.8), shorter or longer, held 0 included
 *   otherwise                                   → held, even when the two round to different 30-minute steps (AC-3.10)
 * "More than the larger of a and b" is "more than a AND more than b".
 */
export function durationAfterMeasure(heldMs: number | null, measuredMs: number): number {
  if (heldMs === null) return measuredMs;
  const difference = Math.abs(measuredMs - heldMs);
  return difference > MEASURE_MARGIN_FLOOR_MS && difference * MEASURE_MARGIN_DIVISOR > heldMs ? measuredMs : heldMs;
}
