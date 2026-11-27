/**
 * The host of a database connection URL, for the fixtures' "is it on this machine" check. Pure, so a unit test reads it
 * (`databaseUrl.test.ts`).
 */

/**
 * Connection parameters with which libpq takes the host from somewhere other than the URL's authority: `host` and `hostaddr`
 * replace it, and `service` names a `pg_service.conf` entry that can set it. A URL carrying one of them does not connect to the
 * host the check would read, so it is refused, not read.
 */
const HOST_PARAMETERS = new Set(['host', 'hostaddr', 'service'])

/**
 * The host of a postgres URL, lower-cased and without the brackets of an IPv6 literal, or `null` when it is not a URL or when
 * a parameter moves the real host (see above). The URL is never in an error.
 */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    for (const name of parsed.searchParams.keys()) {
      if (HOST_PARAMETERS.has(name.toLowerCase())) return null
    }
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}
