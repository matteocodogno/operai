/**
 * The e2e fixtures run a destructive-by-default import against the databases `direnv` names, and refuse one that is not on this
 * machine. The check reads the URL's host, so a URL whose real host libpq takes from somewhere else must not pass for a local one
 * (security review INFO): `postgresql://localhost/db?host=prod.example` connects to prod.example.
 */
import { describe, expect, it } from 'vitest'
import { hostOf } from './databaseUrl'

describe('hostOf', () => {
  it('reads the host of a postgres URL', () => {
    expect(hostOf('postgresql://u:p@localhost:5435/crm')).toBe('localhost')
    expect(hostOf('postgres://u:p@127.0.0.1/crm?sslmode=disable')).toBe('127.0.0.1')
    expect(hostOf('postgresql://u:p@[::1]:5435/crm')).toBe('::1')
    expect(hostOf('postgresql://u:p@DB.Example.com/crm')).toBe('db.example.com')
  })

  it('is null for what is not a URL', () => {
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf('')).toBeNull()
  })

  it.each([
    'postgresql://u:p@localhost/crm?host=prod.example.com',
    'postgresql://u:p@localhost/crm?hostaddr=203.0.113.9',
    'postgresql://u:p@localhost/crm?sslmode=disable&host=/var/run/postgresql',
    'postgresql://u:p@localhost/crm?HOST=prod.example.com',
    'postgresql://u:p@localhost/crm?%68ost=prod.example.com',
    'postgresql://u:p@localhost/crm?HostAddr=203.0.113.9',
    'postgresql://u:p@localhost/crm?service=prod',
    'postgresql://u:p@localhost/crm?host=',
  ])('is null for a URL that names a host elsewhere: %s', (url) => {
    expect(hostOf(url)).toBeNull()
  })
})
