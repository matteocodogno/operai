/**
 * MileageAmountField — the read-only `km × rate = amount` breakdown that
 * replaces the Amount/Currency inputs for a `travel_km` expense line (T13,
 * specs/009-mileage-rate/tasks.md, AC-1.1/1.2/1.3/1.6/1.8/2.2; design.md
 * "Screen R2" / the state table under "## Screens & states").
 *
 * Purely a display + client-side data-fetching component: it takes the
 * draft's current `entity`/`date`/`km`, debounces, and resolves the
 * effective rate itself via `lib/ratesApi.ts`'s `GET /rates/effective` — it
 * has no `onChange`/controlled-value prop, because nothing it computes needs
 * to flow back into the parent draft. The employee never types an amount
 * for this type (AC-1.1); `lib/lineDraft.ts`'s `isLineDraftComplete` already
 * drops amount/currency from the completeness check for `travel_km` and
 * deliberately does NOT gate on whether a rate is in effect (design.md F1:
 * "AC-2.2's blocked state is a submission-time gate, not a save-time one"),
 * so this component owes the parent nothing beyond what it renders.
 *
 * State machine (design.md "## Screens & states", Screen R2):
 *   - Idle        — km not yet entered, or entity/date missing. Fully
 *                   DERIVED at render time (never a synchronous `setState`
 *                   inside the effect below, per React's set-state-in-effect
 *                   guidance) — going invalid immediately shows Idle
 *                   regardless of whatever the last fetch settled.
 *   - Calculating — the debounce has elapsed and `GET /rates/effective` is
 *                   actually in flight (not the debounce window itself,
 *                   where nothing meaningful is "in flight" yet); the LAST
 *                   settled content stays on screen throughout (never blanks
 *                   while waiting).
 *   - Computed    — `GET /rates/effective` → `inEffect: true`; renders the
 *                   full `{km} km × {rate} {currency}/km = {amount}`
 *                   breakdown (AC-1.8 — never the amount alone).
 *   - Blocked     — `inEffect: false` (AC-2.2); a persistent, non-error
 *                   `role="status"` message — this is a policy-configuration
 *                   gap, not a user mistake.
 *   - Fetch error — network/5xx; `role="alert"`. No dedicated Retry — the
 *                   field is live, editing km/entity/date re-triggers it.
 *
 * A11y: the settled content renders inside one `aria-live="polite"` region
 * (`role="status"`, or `role="alert"` for the error state only) so a
 * screen-reader user hears the OUTCOME, not every intermediate keystroke —
 * the visible "Calculating…" annotation is `aria-hidden`, kept OUTSIDE that
 * region, precisely so it is never itself announced (design.md
 * "## Accessibility": "announced text updates only when the settled …
 * value actually changes").
 */

import { useEffect, useRef, useState } from 'react'
import { strings } from '../strings'
import type { Entity } from './EntityBadge'
import CurrencyBadge from './CurrencyBadge'
import type { Currency } from '../lib/money'
import { formatMoney, formatRatePerKm } from '../lib/money'
import { computeMileageAmountCents } from '../lib/computeMileageAmountCents'
import * as ratesApi from '../lib/ratesApi'

/** Debounce before resolving the effective rate on a km/entity/date edit (design.md F1 step 3: "a debounced … live recompute"). */
const RATE_FETCH_DEBOUNCE_MS = 400

/** entity → entity-designated currency (spec.md Domain language: "WellD CH → CHF, WellD Italia → EUR, always" — AC-1.6). Used only before any fetch has resolved a currency of its own (the Idle state). */
const ENTITY_CURRENCY: Record<Entity, Currency> = {
  welld_it: 'EUR',
  welld_ch: 'CHF',
}

export type MileageAmountFieldProps = {
  /** The draft's current entity selection — `''` if not yet chosen. */
  entity: Entity | ''
  /** The draft's current date (`YYYY-MM-DD`) — `''` if not yet chosen. */
  date: string
  /** The draft's current km field, as the raw input string (mirrors `LineDraftValue.km`). */
  km: string
}

type SettledState =
  | { kind: 'idle' }
  | { kind: 'computed'; km: number; ratePerKm: string; currency: Currency; amountCents: number }
  | { kind: 'blocked'; entity: Entity; currency: Currency }
  | { kind: 'error' }

export default function MileageAmountField({ entity, date, km }: MileageAmountFieldProps) {
  const t = strings.components.mileageAmountField
  const entityLabels = strings.badges.entity

  const [settled, setSettled] = useState<SettledState>({ kind: 'idle' })
  const [loading, setLoading] = useState(false)
  const requestTokenRef = useRef(0)

  const kmValue = Number(km)
  const isValidInput = entity !== '' && date !== '' && km.trim() !== '' && Number.isFinite(kmValue) && kmValue > 0

  useEffect(() => {
    // Idle is entirely derived from `isValidInput` at render time below — it
    // needs no state of its own here. A prior in-flight fetch's eventual
    // resolution still checks its own token below, so it can never overwrite
    // `settled` after this effect has moved on; incrementing the token here
    // (rather than only inside the `isValidInput` branch) is what guarantees
    // that even without a synchronous reset of `settled` on this branch.
    if (!isValidInput) {
      requestTokenRef.current += 1
      return
    }

    requestTokenRef.current += 1
    const token = requestTokenRef.current
    const currentEntity = entity as Entity

    const timer = setTimeout(() => {
      // "loading" turns on right as the debounced fetch actually starts
      // (not synchronously at the top of the effect) — both to give React's
      // set-state-in-effect guidance its intended "no setState before an
      // async boundary" shape, and because there is nothing meaningfully "in
      // flight" to announce during the debounce window itself.
      setLoading(true)
      void ratesApi
        .getEffectiveRate(currentEntity, date)
        .then((result) => {
          if (requestTokenRef.current !== token) return // superseded by a later edit — ignore this stale response
          setLoading(false)
          if (result.inEffect) {
            setSettled({
              kind: 'computed',
              km: kmValue,
              ratePerKm: result.ratePerKm,
              currency: result.currency,
              amountCents: computeMileageAmountCents(kmValue, result.ratePerKmMicros),
            })
          } else {
            setSettled({ kind: 'blocked', entity: currentEntity, currency: result.currency })
          }
        })
        .catch(() => {
          if (requestTokenRef.current !== token) return
          setLoading(false)
          setSettled({ kind: 'error' })
        })
    }, RATE_FETCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [entity, date, km, kmValue, isValidInput])

  // Idle is fully derived from `isValidInput`, not a value the effect above
  // ever sets — going invalid (km cleared, entity/date unpicked) shows Idle
  // immediately regardless of whatever `settled` last held.
  const displaySettled: SettledState = isValidInput ? settled : { kind: 'idle' }
  const displayLoading = isValidInput && loading

  const currency: Currency | null =
    displaySettled.kind === 'computed' || displaySettled.kind === 'blocked'
      ? displaySettled.currency
      : entity !== ''
        ? ENTITY_CURRENCY[entity]
        : null

  const isError = displaySettled.kind === 'error'
  const isBlocked = displaySettled.kind === 'blocked'

  const statusText =
    displaySettled.kind === 'idle'
      ? t.idlePrompt
      : displaySettled.kind === 'computed'
        ? t.breakdown(
            displaySettled.km,
            formatRatePerKm(displaySettled.ratePerKm, displaySettled.currency),
            formatMoney(displaySettled.amountCents, displaySettled.currency),
          )
        : displaySettled.kind === 'blocked'
          ? t.blocked(entityLabels[displaySettled.entity])
          : t.fetchError

  const statusColor = isError ? 'var(--red)' : isBlocked ? 'var(--org)' : 'var(--text)'

  return (
    <div className="flex flex-col gap-1" data-testid="mileage-amount-field">
      <span className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
        {t.label}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {currency && <CurrencyBadge currency={currency} />}
        <p
          role={isError ? 'alert' : 'status'}
          aria-live="polite"
          data-testid="mileage-amount-status"
          className="text-sm"
          style={{ color: statusColor }}
        >
          {statusText}
        </p>
        {displayLoading && (
          <span
            aria-hidden="true"
            data-testid="mileage-amount-loading"
            className="text-[11px]"
            style={{ color: 'var(--muted)' }}
          >
            {t.calculating}
          </span>
        )}
      </div>
    </div>
  )
}
