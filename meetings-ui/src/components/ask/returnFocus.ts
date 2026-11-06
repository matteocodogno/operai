/**
 * returnFocus — remembers which source (citation button) opened a transcript segment, so that when
 * the Ask tab comes back ("Back to the answer", F12) focus returns to that very button.
 *
 * The Ask panel unmounts while the Transcript tab is shown, so the memory has to outlive it; it is a
 * single module-level value, taken (and cleared) by the first panel that mounts afterwards.
 */
let remembered: { meetingId: string; key: string } | null = null

export const rememberSource = (meetingId: string, key: string): void => {
  remembered = { meetingId, key }
}

/** The remembered source key for this meeting, once; null when there is none. */
export function takeRememberedSource(meetingId: string): string | null {
  if (remembered === null || remembered.meetingId !== meetingId) return null
  const { key } = remembered
  remembered = null
  return key
}
