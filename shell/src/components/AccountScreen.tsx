/**
 * AccountScreen — shell route `/account` ("My profile" in UserMenu), the
 * employee self-view (specs/012-employee-address, T14, US-6,
 * AC-6.1/AC-6.2/AC-6.3/AC-6.4; design.md "F6 — Employee views their own
 * address, read-only" / "`AccountScreen` — shell route `/account`"; ADR-0034).
 *
 * Mirrors `NoAccessScreen.tsx` structurally (a small, shell-local, zero-
 * dependency screen component) and is built entirely from reused parts:
 *   - the loading/error+retry VISUAL LANGUAGE of `RemoteMount.tsx`'s
 *     `RemoteLoadingFallback`/`RemoteErrorFallback` (spinner classes,
 *     `role="alert"` + `border-org`/`bg-org/10`/`text-org` + a bordered
 *     "Retry" button) — recreated here rather than imported, since those two
 *     are module-private to `RemoteMount.tsx` and this task's scope does not
 *     touch that file;
 *   - the read-only VALUE-DISPLAY register of `admin-ui/src/pages/
 *     UserDetail.tsx`'s Identity block (a plain-text value, no input) —
 *     ported as a styling convention across the federation boundary (that
 *     file lives in a different remote and uses a different, inline-style
 *     CSS-variable convention; this component expresses the same register
 *     using shell's own Tailwind token classes, see `styles/tokens.css`).
 *
 * **AC-6.2 — read-only guarantee, a literal DOM constraint, not a
 * suggestion.** Everything this screen can render lives inside the single
 * `data-testid="account-address-region"` container below, in EVERY state
 * (loading / error / empty / populated) — the plan's own AC-6.2 test queries
 * exactly that region for `input, textarea, select, [contenteditable],
 * button[type="submit"]` and any `role="listbox"`/`role="combobox"` element,
 * and must find none. There is no such element anywhere in this file: the
 * Retry button below is deliberately `type="button"` (never the default
 * `"submit"`), and nothing here is a `<input>`/`<select>`/`<textarea>` — a
 * *disabled* input would still trip that query, so this component doesn't
 * render one at all, not even disabled.
 *
 * **Fetch failure vs. "no address on file" — two distinct states, never
 * conflated.** `getMyAddress()` (./lib/profileApi) resolves to `null` for a
 * genuine, informative "no address on file" and THROWS for anything else (a
 * non-2xx response, a network failure). This component renders a distinct
 * `role="alert"` error+retry state for the latter — collapsing the two would
 * tell an employee something false about their own personal data (design.md
 * F6 step 4).
 *
 * i18n: per design.md "i18n" — `admin-ui` has no i18n runtime today, and
 * neither does `shell`; this screen's copy follows the SAME stateless
 * heuristic design.md prescribes for `admin-ui`'s `addressCopy.ts`
 * (`navigator.language` starting with `"it"` selects `it`, else `en`)
 * inlined here rather than as a separate module, since this task's `touch:`
 * scope (specs/012-employee-address/tasks.md T14) does not add a new shell
 * copy file.
 */

import { useEffect, useState } from 'react'
import { getMyAddress, type AddressView } from '../lib/profileApi'

type AccountState = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; address: AddressView | null }

const COPY = {
  sectionTitle: { en: 'Home address', it: 'Indirizzo di casa' },
  loading: { en: 'Loading your address…', it: 'Caricamento del tuo indirizzo…' },
  error: { en: "Couldn't load your address.", it: 'Impossibile caricare il tuo indirizzo.' },
  retry: { en: 'Retry', it: 'Riprova' },
  none: { en: 'No address on file', it: 'Nessun indirizzo registrato' },
  contactAdmin: {
    en: 'Contact an admin to update this.',
    it: 'Contatta un amministratore per aggiornarlo.',
  },
} as const

type CopyKey = keyof typeof COPY

/** `navigator.language` starting with "it" selects `it`, everything else falls back to `en`. */
function resolveLocale(): 'it' | 'en' {
  if (typeof navigator === 'undefined' || typeof navigator.language !== 'string') {
    return 'en'
  }
  return navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en'
}

function t(key: CopyKey): string {
  return COPY[key][resolveLocale()]
}

export function AccountScreen() {
  const [state, setState] = useState<AccountState>({ status: 'loading' })
  // Bumped by Retry to re-run the effect below. Kept separate from `state`
  // deliberately: see the effect's doc comment for why Retry doesn't call an
  // async fetch function directly.
  const [reloadToken, setReloadToken] = useState(0)

  // Fetches the caller's address on mount and whenever `reloadToken` changes
  // (Retry). Built as an explicit Promise chain rather than an async/await
  // helper invoked from the effect — mirrors admin-ui's AuditPage.tsx (same
  // gotcha, same fix): an async function that calls a state setter anywhere
  // in its body (even after an `await`) reads, to
  // `react-hooks/set-state-in-effect`'s static analysis, as "this effect
  // calls setState directly" — the very pattern the rule polices — because
  // await-continuations stay within the same function body. Routing each
  // setState call through its own `.then()`/`.catch()` closure keeps the
  // state transition genuinely decoupled from the effect's own body, while
  // the runtime behavior (set loading, fetch, then set loaded/error,
  // ignoring a stale response after unmount/retry) is unchanged from the
  // equivalent async/await version.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => getMyAddress())
      .then((address) => {
        if (!cancelled) setState({ status: 'loaded', address })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' })
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const retry = () => setReloadToken((current) => current + 1)

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-12" data-testid="account-screen">
      <h1 className="font-disp text-lg font-semibold text-text">{t('sectionTitle')}</h1>

      {/* AC-6.2 — every state this screen can render lives inside this one
          region; none of them contain an interactive element (see module doc). */}
      <div data-testid="account-address-region">
        {state.status === 'loading' && (
          <div className="flex items-center gap-3 py-2" data-testid="account-loading">
            <div aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-rule border-t-acc" />
            <p className="sr-only" aria-live="polite">
              {t('loading')}
            </p>
          </div>
        )}

        {state.status === 'error' && (
          <div
            role="alert"
            data-testid="account-error"
            className="flex items-center justify-between gap-4 rounded-md border border-org/40 bg-org/10 px-4 py-3 text-sm text-org"
          >
            <span>{t('error')}</span>
            <button
              type="button"
              onClick={retry}
              className="shrink-0 border border-org/60 px-2.5 py-1 text-xs font-medium text-org transition-colors hover:bg-org/20"
            >
              {t('retry')}
            </button>
          </div>
        )}

        {state.status === 'loaded' && (
          <div className="flex flex-col gap-3">
            {state.address ? (
              <p className="text-sm text-text" data-testid="account-address-formatted">
                {state.address.formatted}
              </p>
            ) : (
              <p className="text-sm text-soft" data-testid="account-address-empty">
                {t('none')}
              </p>
            )}
            <p className="text-xs text-muted">{t('contactAdmin')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default AccountScreen
