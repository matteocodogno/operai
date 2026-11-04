/**
 * backoff — the growing wait between two polls (`hooks/usePolling.ts`). A meeting that stays in
 * `processing` for minutes should not be asked about every two seconds for the whole time.
 */
export type BackoffOptions = {
  /** The wait before the first re-poll. */
  baseMs: number
  /** Each wait is the previous one times this. */
  factor: number
  /** The wait never grows past this. */
  maxMs: number
}

/** The wait after `currentMs`: grown by `factor`, never shorter than `currentMs`, never past `maxMs`. */
export function nextDelay(currentMs: number, { factor, maxMs }: Pick<BackoffOptions, 'factor' | 'maxMs'>): number {
  return Math.min(maxMs, Math.max(currentMs, Math.round(currentMs * factor)))
}

/** The first `count` waits, for tests and for documenting the schedule. */
export function delaySequence(options: BackoffOptions, count: number): number[] {
  const waits: number[] = []
  let current = Math.min(options.baseMs, options.maxMs)
  for (let index = 0; index < count; index += 1) {
    waits.push(current)
    current = nextDelay(current, options)
  }
  return waits
}
