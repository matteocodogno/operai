/**
 * Whether this shell was built with an hours-api origin (`VITE_HOURS_API_URL`, specs/20261112-time-tracking):
 * without one every hours call 401s (the origin is not trusted by `session`), so the "My hours" entry is not
 * offered at all. Its own module, not `session`, which many tests mock wholesale.
 */
export const isHoursConfigured = (): boolean => {
  const url = import.meta.env.VITE_HOURS_API_URL as string | undefined
  if (!url) return false
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}
