/**
 * T17 — Employee address end-to-end journey (specs/012-employee-address,
 * plan.md "Test strategy → e2e", tasks.md T17). Drives the REAL assembled
 * shell host + admin-ui remote (ADR-0006) against the REAL `auth` service —
 * no backend mocking — mirroring this suite's existing cross-app e2e
 * convention (invitations.spec.ts, mileage-rate.spec.ts, refund-headline
 * .spec.ts).
 *
 * Journey (plan.md's own four numbered steps, US-1/US-2/US-4/US-6,
 * AC-1.2/AC-6.1/AC-6.2 — the un-gated `/account` route guarantee, ADR-0034,
 * is the one thing only e2e can prove; every other AC this feature touches
 * is independently proven at unit/integration/component level per plan.md's
 * test-strategy table):
 *   1. Seeded admin session → `/admin/users/<id>` → address section visible,
 *      "No address on file".
 *   2. Type 3+ characters in the Street field → a STUBBED suggestion appears
 *      → select it → every structured field populates (AC-2.2).
 *   3. Save → reload the page → the address is still shown, unchanged
 *      (AC-1.2, proven end-to-end through the real stack, not just the
 *      component's local state).
 *   4. Sign in as a NON-ADMIN employee (the SAME employee whose address the
 *      admin just set, tying both halves of the journey to one real,
 *      persisted record) → `/admin/*` is not reachable (AC-4.1 "including
 *      their own") → `/account` IS reachable and shows the SAME address,
 *      read-only (AC-6.1/AC-6.2).
 *
 * ─── Google Places — network-layer + SDK-layer stub, ZERO real requests ───
 * Two independent, redundant layers, per this task's own mandate ("Google
 * MUST be stubbed at the network layer") and plan.md's "the suite never hits
 * a billed third party in CI":
 *   (a) PRIMARY: `installFakeGooglePlaces()` below seeds a fake
 *       `window.google.maps.importLibrary` via `page.addInitScript()` BEFORE
 *       admin-ui's own bundle ever runs. `googlePlaces.ts`'s
 *       `loadPlacesLibrary()` checks `window.google?.maps?.importLibrary`
 *       BEFORE ever injecting the real
 *       `<script src="https://maps.googleapis.com/maps/api/js?...">`
 *       bootstrap tag — pre-seeding it here means that tag is NEVER
 *       requested. This also gives full, deterministic control over the
 *       suggestion/selection response shape, exercising the REAL production
 *       `googlePlaces.ts`/`AddressSection.tsx` code paths (debounce,
 *       session-token lifecycle, component mapping) rather than guessing at
 *       Google's actual (undocumented, versioned) wire protocol.
 *   (b) BELT-AND-BRACES: `page.route('**\/places.googleapis.com/**')` +
 *       the bootstrap host `**\/maps.googleapis.com/**` are both aborted
 *       too, so even a future refactor of `googlePlaces.ts` that bypassed
 *       (a) would still make zero real network calls to Google, never a
 *       silent fallthrough to the live API.
 *
 * ─── STACK REQUIREMENT this journey depends on (discovered, not created,
 * by this task) ───────────────────────────────────────────────────────────
 * `admin-ui`'s `loadPlacesLibrary()` throws BEFORE ever checking
 * `window.google` if `import.meta.env.VITE_GOOGLE_MAPS_API_KEY` is falsy —
 * a Vite build-time value, baked into the bundle when `admin-ui` is built
 * (shell/playwright.config.ts's admin-ui `webServer` entry runs
 * `pnpm build && pnpm preview`, per its own module doc: "build+preview, NOT
 * vite dev"). That entry does not currently set `VITE_GOOGLE_MAPS_API_KEY`,
 * and tasks.md's T16 records its real-key provisioning as "BLOCKED ON A
 * HUMAN" (GCP console + 1Password + Vercel access no agent has) — so no
 * environment this repo can build today has a real key wired in anywhere.
 * Because step (a) above fully replaces the SDK before it would ever read
 * that key's VALUE, the key does not need to be real — it only needs to be
 * NON-EMPTY so `loadPlacesLibrary()` doesn't short-circuit before reaching
 * the (fully stubbed) `window.google`. Run this spec with e.g.
 * `VITE_GOOGLE_MAPS_API_KEY=e2e-stub-not-a-real-key pnpm e2e` from `shell/`
 * (Playwright's `webServer.env` merges over, not replaces, `process.env`,
 * so an exported shell var reaches admin-ui's build). Without it, step 2's
 * suggestion never appears — admin-ui takes the documented AC-3.2 graceful-
 * degradation path instead — and this spec fails at that assertion. This is
 * a pre-existing environment gap (tasks.md T16), not a defect in this file;
 * this task's own `touch:` scope is this spec file only, so the harness
 * config is deliberately left untouched — flagged here and in T17's return
 * for whoever wires CI/local e2e to add the one-line default.
 *
 * STACK REQUIREMENTS (beyond shell/playwright.config.ts's own prerequisites,
 * see that file's header): the `auth` service must be reachable with
 * ENABLE_TEST_AUTH=true (helpers/adminSession.ts's `/test-auth/session`).
 */
import { test, expect, type Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'

// ---------------------------------------------------------------------------
// A minimal, deliberately narrow ambient typing for the fake browser global
// this spec installs — mirrors the slice of `window.google` admin-ui's own
// `googlePlaces.ts` declares for itself (that file's `declare global` lives
// in a different remote/tsconfig program, so it is not visible here).
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    google?: {
      maps: {
        importLibrary: (name: string) => Promise<unknown>
      }
    }
  }
}

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** One fixed, fully-populated fake Google Places suggestion — a real, plausible Milan address (AC-2.2/AC-2.4/AC-2.5's CH/IT-flavored fixture). */
const FAKE_PLACE = {
  id: 'e2e-fake-place-milan-1',
  mainText: 'Via Roma 1',
  secondaryText: '20121 Milano MI, Italy',
  addressComponents: [
    { longText: 'Via Roma', shortText: 'Via Roma', types: ['route'] },
    { longText: '1', shortText: '1', types: ['street_number'] },
    { longText: 'Milano', shortText: 'Milano', types: ['locality'] },
    { longText: '20121', shortText: '20121', types: ['postal_code'] },
    { longText: 'Lombardia', shortText: 'LOM', types: ['administrative_area_level_1'] },
    { longText: 'Italy', shortText: 'IT', types: ['country'] },
  ],
  lat: 45.4642,
  lng: 9.19,
} as const

/**
 * Installs the fake `window.google.maps` global on `page`, active from the
 * very first navigation onward (Playwright re-runs `addInitScript` on every
 * subsequent document load in this page, including the reload in step 3) —
 * see this file's module doc for why this is the PRIMARY stub layer. Also
 * registers the network-layer abort routes (the mandated
 * `page.route('**\/places.googleapis.com/**')`, plus the bootstrap-script
 * host) as a redundant second layer.
 */
async function installFakeGooglePlaces(page: Page): Promise<void> {
  await page.addInitScript((fake) => {
    class FakeAutocompleteSessionToken {}

    window.google = {
      maps: {
        importLibrary: async (name: string) => {
          if (name !== 'places') return {}
          return {
            AutocompleteSessionToken: FakeAutocompleteSessionToken,
            AutocompleteSuggestion: {
              fetchAutocompleteSuggestions: async () => ({
                suggestions: [
                  {
                    placePrediction: {
                      placeId: fake.id,
                      text: { text: `${fake.mainText}, ${fake.secondaryText}` },
                      mainText: { text: fake.mainText },
                      secondaryText: { text: fake.secondaryText },
                      toPlace: () => ({
                        addressComponents: fake.addressComponents,
                        location: { lat: () => fake.lat, lng: () => fake.lng },
                        fetchFields: async () => undefined,
                      }),
                    },
                  },
                ],
              }),
            },
          }
        },
      },
    }
  }, FAKE_PLACE)

  // Belt-and-braces (b) — see module doc. Neither route should ever actually
  // fire given (a) above; if either does, this proves a real request was
  // about to leave the browser, which this task's own mandate forbids.
  await page.route('**/places.googleapis.com/**', (route) => route.abort())
  await page.route('**/maps.googleapis.com/**', (route) => route.abort())
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/012-employee-address T17: admin sets an employee address end-to-end, the employee sees it read-only', () => {
  test('admin edits an employee address via suggestion selection, it survives a reload, and the SAME non-admin employee can see it (read-only) at /account but never reach /admin/*', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const adminEmail = `e2e-address-admin-${tag}@operai.test`
    const empEmail = `e2e-address-emp-${tag}@operai.test`

    const adminSession = await seedAdminSession(adminEmail, 'E2E Address Admin')
    // Deliberately NOT granted any admin/catalog capability — a plain,
    // baseline signed-in user (AC-4.1's "including their own", AC-6.1's
    // "any signed-in employee").
    const empSession = await seedUserSession(empEmail, 'E2E Address Employee')

    const adminContext = await browser.newContext()
    await applySessionCookie(adminContext, adminSession)
    const adminPage = await adminContext.newPage()
    await installFakeGooglePlaces(adminPage)

    const empContext = await browser.newContext()
    await applySessionCookie(empContext, empSession)
    const empPage = await empContext.newPage()

    // ─── Step 1: admin opens the employee's profile, address section visible, empty ──
    await adminPage.goto(`/admin/users/${empSession.userId}`)
    await expect(adminPage.getByTestId('admin-user-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(adminPage.getByTestId('address-section')).toBeVisible({ timeout: 20_000 })
    await expect(adminPage.getByTestId('address-current-line')).toHaveText('No address on file', {
      timeout: 10_000,
    })

    // ─── Step 2: type 3+ chars → the STUBBED suggestion appears → select it → fields populate (AC-2.1/2.2) ──
    const streetInput = adminPage.getByTestId('address-street-combobox')
    await streetInput.fill('Via Roma')

    const suggestionOption = adminPage.getByTestId(`address-street-combobox-option-${FAKE_PLACE.id}`)
    await expect(suggestionOption).toBeVisible({ timeout: 10_000 })
    await expect(suggestionOption).toContainText(FAKE_PLACE.mainText)
    await suggestionOption.click()

    await expect(streetInput).toHaveValue('Via Roma', { timeout: 10_000 })
    await expect(adminPage.getByTestId('address-housenumber-input')).toHaveValue('1')
    await expect(adminPage.getByTestId('address-city-input')).toHaveValue('Milano')
    await expect(adminPage.getByTestId('address-postalcode-input')).toHaveValue('20121')
    await expect(adminPage.getByTestId('address-region-input')).toHaveValue('Lombardia')
    await expect(adminPage.getByTestId('address-country-combobox')).toHaveValue('Italy')
    // AC-2.5 — a selected suggestion's coordinates are captured.
    await expect(adminPage.getByTestId('address-coords-status')).toContainText(
      'captured from suggestion',
    )

    // ─── Step 3: save → reload → still shown, unchanged (AC-1.2, end-to-end through the real stack) ──
    await adminPage.getByTestId('address-save-button').click()
    await expect(adminPage.getByTestId('address-current-line')).toContainText('Via Roma 1', {
      timeout: 15_000,
    })
    await expect(adminPage.getByTestId('address-current-line')).toContainText('Milano')

    await adminPage.reload()
    await expect(adminPage.getByTestId('address-section')).toBeVisible({ timeout: 20_000 })
    await expect(adminPage.getByTestId('address-current-line')).toContainText('Via Roma 1', {
      timeout: 15_000,
    })
    await expect(adminPage.getByTestId('address-current-line')).toContainText('Milano')

    // ─── Step 4a: the SAME employee, now signed in as themselves (non-admin), cannot reach /admin/* — not even their OWN record (AC-4.1) ──
    await empPage.goto(`/admin/users/${empSession.userId}`)
    await expect(empPage.getByTestId('admin-user-detail-page')).toHaveCount(0, { timeout: 15_000 })
    await expect(empPage).not.toHaveURL(/\/admin(\/|$)/, { timeout: 15_000 })

    // ─── Step 4b: /account IS reachable and shows the SAME address, read-only (AC-6.1/AC-6.2, ADR-0034) ──
    await empPage.goto('/account')
    await expect(empPage.getByTestId('account-screen')).toBeVisible({ timeout: 20_000 })
    await expect(empPage.getByTestId('account-address-formatted')).toContainText('Via Roma 1', {
      timeout: 15_000,
    })
    await expect(empPage.getByTestId('account-address-formatted')).toContainText('Milano')

    // AC-6.2 — read-only in its entirety: the one region every state of this
    // screen renders inside contains no interactive/editable element and no
    // combobox/listbox, matching plan.md's own test-strategy recipe for this AC.
    const addressRegion = empPage.getByTestId('account-address-region')
    await expect(
      addressRegion.locator('input, textarea, select, [contenteditable], button[type="submit"]'),
    ).toHaveCount(0)
    await expect(addressRegion.locator('[role="listbox"], [role="combobox"]')).toHaveCount(0)

    await adminContext.close()
    await empContext.close()
  })
})
