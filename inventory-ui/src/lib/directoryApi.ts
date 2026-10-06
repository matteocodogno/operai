import { getAuthBaseUrl } from 'shell/session'
import { requestJson } from './api'
import type { DirectoryUser } from './types'

/**
 * `auth GET /authz/users/directory` — the holder picker's and holder filter's
 * user list (plan.md R4). Unlike every other client here it targets the `auth`
 * service (`getAuthBaseUrl()`), through the same `apiFetch`. Active users only,
 * name-sorted; the caller must hold `asset:manage` (403 otherwise) and is
 * rate-limited (429 carries `retryAfterSeconds`).
 */
export const listDirectory = (init?: RequestInit): Promise<{ users: DirectoryUser[] }> =>
  requestJson<{ users: DirectoryUser[] }>(getAuthBaseUrl(), '/authz/users/directory', init)
