/**
 * Admin-session seeding for specs/006-user-invitations e2e (T14).
 *
 * Mirrors `seedSession.ts`'s Set-Cookie-mint pattern (and
 * `notifications.spec.ts`'s Node-context `seedUser`/token helpers) but for an
 * ADMIN-privileged @operai.test user — needed because every invitation/
 * delete screen this feature adds lives behind `requireAdmin`
 * (specs/004-auth-roles-permissions), and there is no test-only "mint an
 * admin session" endpoint (nor should there be — see inviteFixtures.ts's doc
 * comment on why role-granting goes through direct DB access instead).
 */
import type { BrowserContext } from '@playwright/test'
import { grantRole } from './inviteFixtures'

const AUTH_URL = (
  process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001'
).replace(/\/$/, '')

export interface SeededSession {
  email: string
  userId: string
  cookieHeader: string
  token: string
}

/** Mints a real better-auth session for an arbitrary @operai.test user (idempotent by email). */
export async function seedUserSession(email: string, name: string): Promise<SeededSession> {
  const res = await fetch(`${AUTH_URL}/test-auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  })
  if (!res.ok) {
    throw new Error(`[adminSession] POST /test-auth/session failed (${res.status}): ${await res.text()}`)
  }
  const body = (await res.json()) as { userId: string; email: string }
  const rawCookieHeader = res.headers.get('set-cookie')
  if (!rawCookieHeader) throw new Error('[adminSession] no Set-Cookie from /test-auth/session')
  const cookieHeader = rawCookieHeader.split(';')[0]!.trim()

  const tokenRes = await fetch(`${AUTH_URL}/auth/token`, { headers: { Cookie: cookieHeader } })
  if (!tokenRes.ok) throw new Error(`[adminSession] GET /auth/token failed (${tokenRes.status})`)
  const { token } = (await tokenRes.json()) as { token: string }

  return { email, userId: body.userId, cookieHeader, token }
}

/** Seeds a session for `email` AND grants it the `admin` role (direct DB, see inviteFixtures.ts). */
export async function seedAdminSession(email: string, name: string): Promise<SeededSession> {
  const session = await seedUserSession(email, name)
  grantRole(email, 'admin')
  return session
}

/** Injects a seeded session's cookie into a Playwright BrowserContext, scoped to the auth origin's host. */
export async function applySessionCookie(context: BrowserContext, session: SeededSession): Promise<void> {
  const eqIdx = session.cookieHeader.indexOf('=')
  const name = session.cookieHeader.slice(0, eqIdx)
  const value = session.cookieHeader.slice(eqIdx + 1)
  const domain = new URL(AUTH_URL).hostname
  await context.addCookies([{ name, value, domain, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }])
}
