/**
 * T21 — Notification center end-to-end (specs/005-notification-center).
 *
 * Drives the REAL assembled shell + notify-ui + notify-api (+ auth +
 * estimai-api for the cross-remote-link case) — no mocks. Covers the ACs
 * plan.md's test-strategy assigns to the "e2e" level:
 *   AC-1.4, AC-1.5 (SSE push → bell badge, single tab + multi-tab)
 *   AC-2.1, AC-2.4, AC-2.5 (open center, empty state, follow a link)
 *   AC-3.1, AC-3.2, AC-3.3 (open marks read, was-unread affordance, reload clears it)
 *   AC-5.1, AC-5.5, AC-5.6 (toast on toast-worthy, no toast otherwise, no toast
 *     for a notification raised while disconnected)
 *   AC-6.2, AC-6.3 (two-user isolation; sign-out/sign-in user switch)
 *
 * STACK REQUIREMENTS (see shell/playwright.config.ts webServer + its own
 * prerequisites doc comment): Postgres (5435); auth (3001,
 * ENABLE_TEST_AUTH=true); estimai-api (8080, only for the AC-2.5 cross-remote
 * link target); notify-api (8081); shell + estimai-ui + refund-ui + notify-ui
 * built & previewed.
 *
 * Node-context helpers below mint REAL better-auth sessions/JWTs via the
 * test-auth gate (mirrors estimai-identity-jwks.spec.ts's pattern) and call
 * notify-api directly to RAISE notifications — there is no UI surface for
 * raising one (design.md Flow 6: "no UI surface in this design"), so this is
 * the only way to drive US-4 from an e2e test, exactly as plan.md's test
 * strategy anticipates.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { seedSession, E2E_TEST_USER } from './helpers/seedSession'

const AUTH_ORIGIN = (
  process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001'
).replace(/\/$/, '')
const NOTIFY_ORIGIN = (
  process.env['E2E_NOTIFY_API_URL'] ?? process.env['VITE_NOTIFY_API_URL'] ?? 'http://localhost:8081'
).replace(/\/$/, '')

// ─── Node-context helpers (no browser) ──────────────────────────────────────

interface SeededUser {
  email: string
  cookieHeader: string
  token: string
}

/** Mints a real better-auth session + JWT for an arbitrary @operai.test user. */
async function seedUser(email: string, name: string): Promise<SeededUser> {
  const res = await fetch(`${AUTH_ORIGIN}/test-auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
  })
  if (!res.ok) {
    throw new Error(`[notify-e2e] POST /test-auth/session failed (${res.status}): ${await res.text()}`)
  }
  const rawCookieHeader = res.headers.get('set-cookie')
  if (!rawCookieHeader) throw new Error('[notify-e2e] no Set-Cookie from /test-auth/session')
  const cookieHeader = rawCookieHeader.split(';')[0].trim()

  const tokenRes = await fetch(`${AUTH_ORIGIN}/auth/token`, { headers: { Cookie: cookieHeader } })
  if (!tokenRes.ok) throw new Error(`[notify-e2e] GET /auth/token failed (${tokenRes.status})`)
  const { token } = (await tokenRes.json()) as { token: string }
  if (!token) throw new Error('[notify-e2e] /auth/token returned no token')

  return { email, cookieHeader, token }
}

/** Injects a seeded user's session cookie into a Playwright BrowserContext. */
async function applyUserCookie(context: BrowserContext, user: SeededUser): Promise<void> {
  const eqIdx = user.cookieHeader.indexOf('=')
  const name = user.cookieHeader.slice(0, eqIdx)
  const value = user.cookieHeader.slice(eqIdx + 1)
  await context.addCookies([
    { name, value, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ])
}

interface RaiseInput {
  title: string
  body: string
  severity?: 'info' | 'success' | 'warning' | 'error'
  originApp?: 'estimai' | 'refund' | 'admin'
  link?: { href: string; label?: string }
  toast?: boolean
}

interface RaisedNotification {
  id: string
  title: string
  toastWorthy: boolean
}

/** Raises a notification directly against notify-api (US-4 — no UI surface exists to drive this, design.md Flow 6). */
async function raiseNotification(token: string, input: RaiseInput): Promise<RaisedNotification> {
  const res = await fetch(`${NOTIFY_ORIGIN}/notifications`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ severity: 'info', originApp: 'estimai', toast: false, ...input }),
  })
  if (res.status !== 201) {
    throw new Error(`[notify-e2e] raise failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as RaisedNotification
}

/** Reads the Bell's badge text (or null if no badge is rendered — AC-1.3). */
async function readBellBadge(page: Page): Promise<string | null> {
  const bell = page.getByRole('link', { name: 'Notifications' })
  const badge = bell.locator('span[aria-hidden="true"]')
  if ((await badge.count()) === 0) return null
  return badge.textContent()
}

const runId = Date.now().toString(36)

// ─── AC-1.1 / AC-2.1: the bell is present everywhere, and opens the center ──

test.describe('AC-1.1/AC-2.1: the bell is present on every route and opens /notify', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('bell renders beside the theme toggle on a tool route, and activating it opens the notification center', async ({
    page,
  }) => {
    await page.goto('/estimai')
    const bell = page.getByRole('link', { name: 'Notifications' })
    await expect(bell, 'Bell must render on a tool route (AC-1.1)').toBeVisible({ timeout: 15_000 })

    await bell.click()
    await expect(page).toHaveURL(/\/notify$/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible({ timeout: 15_000 })
  })
})

// ─── AC-2.4: explicit empty state ───────────────────────────────────────────

test.describe('AC-2.4: a user with no notifications sees an explicit empty state', () => {
  test('never-notified user sees "Nothing here yet", not a blank area or error', async ({
    page,
    context,
  }) => {
    const user = await seedUser(`ac24-${runId}@operai.test`, 'AC-2.4 User')
    await applyUserCookie(context, user)

    await page.goto('/notify')
    await expect(page.getByTestId('notify-empty-state')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Nothing here yet')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

// ─── AC-3.1 / AC-3.2 / AC-3.3: open marks read, was-unread affordance ───────

test.describe('AC-3.1/3.2/3.3: opening the center marks unread as read, with a per-session affordance', () => {
  test('open center clears the badge and tags items "New"; a reload shows them plain-read with no badge regression', async ({
    page,
    context,
  }) => {
    const user = await seedUser(`ac31-${runId}@operai.test`, 'AC-3.1 User')
    await applyUserCookie(context, user)
    await raiseNotification(user.token, { title: 'AC-3.1 item', body: 'unread on raise' })

    // Seed the badge via a normal mount first (REST-seeded unread count —
    // independent of the live SSE push, see AC-1.2/1.3's own unit coverage).
    await page.goto('/estimai')
    await expect(page.getByRole('link', { name: 'Notifications' })).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(() => readBellBadge(page), { timeout: 15_000 })
      .toBe('1')

    await page.getByRole('link', { name: 'Notifications' }).click()
    await expect(page).toHaveURL(/\/notify$/)
    await expect(page.getByText('1 notification loaded')).toBeVisible({ timeout: 15_000 })

    // AC-3.1: badge clears immediately in the acting tab.
    await expect.poll(() => readBellBadge(page), { timeout: 15_000 }).toBeNull()

    // AC-3.2: was-unread affordance present THIS viewing session (three
    // independent non-color channels per design.md — assert at least the
    // visible "New" tag and the sr-only prefix, both present here).
    await expect(page.getByText('New', { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId(/notification-new-prefix-/)).toHaveCount(1)

    // AC-3.3: leaving and returning via a fresh navigation (reload) starts a
    // clean viewing session — no "New" affordance survives, and the badge
    // stays at 0 (it was already marked read server-side).
    await page.reload()
    await expect(page.getByText('1 notification loaded')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('New', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId(/notification-new-prefix-/)).toHaveCount(0)
    await expect.poll(() => readBellBadge(page), { timeout: 15_000 }).toBeNull()
  })
})

// ─── AC-2.5 (CRITICAL): following a linked notification crosses the remote boundary ──

test.describe('AC-2.5: activating a linked notification navigates to its destination, even across a different mounted remote', () => {
  test('clicking a notification linking to /estimai while notify-ui (a DIFFERENT remote) is mounted actually mounts EstimAI', async ({
    page,
    context,
  }) => {
    const user = await seedUser(`ac25-${runId}@operai.test`, 'AC-2.5 User')
    await applyUserCookie(context, user)
    await raiseNotification(user.token, {
      title: 'AC-2.5 cross-remote link',
      body: 'Follow me to EstimAI',
      link: { href: '/estimai', label: 'Open EstimAI' },
    })

    // The notification center (notify-ui) is itself the "different remote"
    // relative to the link's target (estimai-ui) — ANY non-/notify link
    // target is inherently cross-remote here (ADR-0006's per-remote nested-
    // router model: notify-ui never mounts estimai-ui's routes itself).
    await page.goto('/notify')
    const item = page.getByTestId(new RegExp('^notification-item-'))
    await expect(item).toBeVisible({ timeout: 15_000 })
    await item.click()

    // EXPECTED (per AC-2.5 / the spec): the shell's top-level router mounts
    // EstimAI at /estimai. Flagged by the T15 dev as the untested boundary —
    // this is the check that actually proves (or disproves) it.
    //
    // NOTE: the URL match is intentionally ANCHORED (not a bare /\/estimai/
    // substring match) — TanStack Router's `basepath`-rebased `<Link>` inside
    // notify-ui's OWN inner router resolves an "absolute-looking" `to="/estimai"`
    // AS IF IT WERE RELATIVE TO notify-ui's OWN basepath, producing
    // "/notify/estimai" instead — which a loose `/\/estimai/` substring regex
    // would wrongly accept (it still contains "/estimai"). Anchoring the
    // match, and asserting /notify is genuinely gone from the URL plus real
    // EstimAI content is visible, is what actually distinguishes "reached
    // EstimAI" from "silently 404'd inside notify-ui's own router at a
    // bogus /notify/estimai path" — a mistake caught during QE verification
    // by comparing this automated result against a manual repro.
    await expect(page, 'must land on the real /estimai route, not a mis-resolved /notify/estimai').toHaveURL(
      /^http:\/\/localhost:\d+\/estimai(\/|$|\?)/,
      { timeout: 15_000 },
    )
    await expect(page.url(), 'must not still be under /notify').not.toContain('/notify')
    await expect(page.getByText('Page not found')).toHaveCount(0)
    // Real EstimAI content, not notify-ui's not-found fallback.
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({ timeout: 15_000 })
  })
})

// ─── AC-5.1 / AC-5.5: toast on toast-worthy, no toast otherwise ─────────────

test.describe('AC-5.1/5.5: a toast-worthy notification pops a transient toast over the mounted remote; a non-toast one does not', () => {
  test('raising toast:true while EstimAI is mounted pops a toast there; toast:false pops nothing', async ({
    page,
    context,
  }) => {
    const user = await seedUser(`ac51-${runId}@operai.test`, 'AC-5.1 User')
    await applyUserCookie(context, user)

    // Mount a remote OTHER than notify-ui so "toast appears over whichever
    // app the user currently has open" (AC-5.1) is genuinely exercised.
    await page.goto('/estimai')
    await expect(page.getByRole('link', { name: 'Notifications' })).toBeVisible({ timeout: 15_000 })
    // Let the SSE connection establish before raising (US-1's "the suite has
    // the tab open" precondition for a toast to appear at all).
    await page.waitForTimeout(2_000)

    await raiseNotification(user.token, {
      title: 'AC-5.1 toast-worthy',
      body: 'should pop a toast',
      toast: true,
    })

    // Control assertion FIRST: if this doesn't appear, the SSE transport
    // itself is broken (see AC-1.4/1.5) and the AC-5.5 assertion below would
    // otherwise pass vacuously for the wrong reason.
    await expect(
      page.getByRole('status').filter({ hasText: 'AC-5.1 toast-worthy' }),
      'a toast-worthy raise while the suite is open must pop a transient toast (AC-5.1)',
    ).toBeVisible({ timeout: 10_000 })

    await raiseNotification(user.token, {
      title: 'AC-5.5 not toast-worthy',
      body: 'should NOT pop a toast',
      toast: false,
    })
    await page.waitForTimeout(3_000)
    await expect(
      page.getByText('AC-5.5 not toast-worthy'),
      'a non-toast-worthy raise must never pop a toast anywhere (AC-5.5)',
    ).toHaveCount(0)
  })
})

// ─── AC-5.6: raised while disconnected → present in center, no toast on reconnect ──

test.describe('AC-5.6: a notification raised while the suite was not open produces no toast later, but is present and unread', () => {
  test('raising toast:true for a user with no open tab, then opening the suite, shows it unread in the center with no toast', async ({
    page,
    context,
  }) => {
    const user = await seedUser(`ac56-${runId}@operai.test`, 'AC-5.6 User')
    // Deliberately raise BEFORE any page/context ever navigates anywhere for
    // this user — there is no SSE connection to receive it live.
    const raised = await raiseNotification(user.token, {
      title: 'AC-5.6 raised while disconnected',
      body: 'must not toast, must be present',
      toast: true,
    })

    await applyUserCookie(context, user)
    await page.goto('/estimai')
    await expect(page.getByRole('link', { name: 'Notifications' })).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(3_000)

    // No toast for the already-past notification (SSE only pushes for
    // connections that were live at raise time — plan.md R3/R5).
    await expect(page.getByText('AC-5.6 raised while disconnected')).toHaveCount(0)

    // But it is present, correctly unread, once the center is opened.
    await page.getByRole('link', { name: 'Notifications' }).click()
    await expect(page).toHaveURL(/\/notify$/)
    const item = page.getByTestId(`notification-item-${raised.id}`)
    await expect(item).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(`notification-new-tag-${raised.id}`)).toBeVisible()
  })
})

// ─── AC-1.4 / AC-1.5: SSE push → badge updates, single tab and multi-tab ────

test.describe('AC-1.4/1.5: a raised notification updates the bell badge live, in every open tab, within ~2s', () => {
  test('a single open tab sees its badge update within ~2s of a raise, with no manual refresh', async ({
    page,
    context,
  }) => {
    const user = await seedUser(`ac14-${runId}@operai.test`, 'AC-1.4 User')
    await applyUserCookie(context, user)

    await page.goto('/estimai')
    await expect(page.getByRole('link', { name: 'Notifications' })).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => readBellBadge(page), { timeout: 15_000 }).toBeNull()

    await raiseNotification(user.token, { title: 'AC-1.4 live push', body: 'badge must update live' })

    // ~2s per the spec; a generous margin over that is still a meaningful
    // proof of "near-real-time, no reload" as long as it isn't the 15s+
    // eventual-consistency window a broken push would need a full reload to
    // reach instead.
    await expect
      .poll(() => readBellBadge(page), {
        timeout: 5_000,
        message: 'bell badge must reflect the new notification via SSE within ~2s, no reload',
      })
      .toBe('1')
  })

  test('two open tabs for the same user both see the badge update within ~2s of one raise', async ({
    browser,
  }) => {
    const user = await seedUser(`ac15-${runId}@operai.test`, 'AC-1.5 User')

    const contextA = await browser.newContext()
    const contextB = await browser.newContext()
    await applyUserCookie(contextA, user)
    await applyUserCookie(contextB, user)
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      await pageA.goto('/estimai')
      await pageB.goto('/estimai')
      await expect(pageA.getByRole('link', { name: 'Notifications' })).toBeVisible({ timeout: 15_000 })
      await expect(pageB.getByRole('link', { name: 'Notifications' })).toBeVisible({ timeout: 15_000 })

      await raiseNotification(user.token, { title: 'AC-1.5 fan-out', body: 'both tabs must update' })

      await expect
        .poll(() => readBellBadge(pageA), { timeout: 5_000, message: 'tab A must update within ~2s' })
        .toBe('1')
      await expect
        .poll(() => readBellBadge(pageB), { timeout: 5_000, message: 'tab B must update within ~2s' })
        .toBe('1')
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })
})

// ─── AC-6.2: two-user isolation ──────────────────────────────────────────────

test.describe('AC-6.2: two different users never see each other\'s notifications', () => {
  test('user A\'s notification never appears in user B\'s center, and vice versa', async ({
    page,
    context,
  }) => {
    const userA = await seedUser(`ac62-a-${runId}@operai.test`, 'AC-6.2 User A')
    const userB = await seedUser(`ac62-b-${runId}@operai.test`, 'AC-6.2 User B')

    await raiseNotification(userA.token, { title: 'Belongs to A only', body: 'A private' })
    await raiseNotification(userB.token, { title: 'Belongs to B only', body: 'B private' })

    await applyUserCookie(context, userA)
    await page.goto('/notify')
    await expect(page.getByText('Belongs to A only')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Belongs to B only')).toHaveCount(0)

    await context.clearCookies()
    await applyUserCookie(context, userB)
    await page.goto('/notify')
    await expect(page.getByText('Belongs to B only')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Belongs to A only')).toHaveCount(0)
  })
})

// ─── AC-6.3: sign out A, sign in B on the same device ───────────────────────

test.describe('AC-6.3: signing out and a different user signing in on the same device shows only the new user\'s notifications', () => {
  test('sign out A (via the shell UserMenu) then sign in B → B sees only B\'s own, and the bell reconnects as B', async ({
    page,
    context,
  }) => {
    const userA = await seedUser(`ac63-a-${runId}@operai.test`, 'AC-6.3 User A')
    await raiseNotification(userA.token, { title: 'A only (AC-6.3)', body: 'must not survive the switch' })

    await applyUserCookie(context, userA)
    await page.goto('/notify')
    await expect(page.getByText('A only (AC-6.3)')).toBeVisible({ timeout: 15_000 })

    // Sign out through the real shell chrome (UserMenu → signOut()), which
    // T10 deliberately makes close-but-not-eagerly-reconnect the SSE (see
    // shell/src/lib/notifications.ts's sign-out teardown doc comment) — the
    // claim under test is that the NEXT mount (a fresh navigation, exactly
    // what a real sign-in redirect always is — router.tsx's guard throws a
    // full-document `redirect({ href })`) reconnects correctly as whoever is
    // signed in at that point.
    const userMenuButton = page.getByRole('button', { name: 'AC-6.3 User A' })
    await expect(userMenuButton).toBeVisible({ timeout: 15_000 })
    await userMenuButton.click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()

    // Seed B and do a FRESH navigation (a real page load) — the same shape
    // every real sign-in redirect takes (router.tsx: `redirect({ href })`
    // infers `reloadDocument: true`), which is what actually resets every
    // module-scope cache (JWT, permissions, and this feature's SSE
    // connection manager) between users on one device.
    const userB = await seedUser(`ac63-b-${runId}@operai.test`, 'AC-6.3 User B')
    await context.clearCookies()
    await applyUserCookie(context, userB)
    await page.goto('/notify')

    await expect(page.getByText('Nothing here yet')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('A only (AC-6.3)')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'AC-6.3 User B' })).toBeVisible({ timeout: 15_000 })
  })
})
