/**
 * Known defence gaps found by the evals (T83). A channel marked with one of these is EXPECTED to
 * fail a server-tier assertion: the run reports it and exits 0, and says when a gap has been
 * closed (a marked channel that now passes) so the marker is removed with the fix.
 *
 * None is open. DEF-1 (invisible/fullwidth characters), DEF-2 (operator/admin keywords) and DEF-3
 * (`[[SYSTEM]]`, numbered/bulleted prefixes) were closed in `sanitizeProse` (T36) and their
 * channels are now plain regression guards. A new gap is an `export const DEF_x = "DEF-n <what>"`
 * here, referenced by `knownGap:` on the channel (README.md, Known gaps).
 */
export {};
