/**
 * ratesApi — refund-ui's read-only client for `refund-api`'s employee-facing
 * mileage-rate resolution endpoint (T12, specs/009-mileage-rate/tasks.md;
 * plan.md "## API contracts": `GET /rates/effective`). This is the ONLY
 * rates endpoint refund-ui calls — rate MANAGEMENT (`GET`/`POST /rates`)
 * lives entirely in admin-ui's own `ratesApi.ts` (plan.md: "admin-ui — the
 * rate MANAGEMENT screen … refund-ui — the employee/accounting line UX
 * only … it only calls the employee-facing GET /rates/effective read").
 *
 * Gated by `refund:access` only (plan.md "Decision 2") — resolving a line's
 * own effective rate needs no `rate:read`/`rate:manage` capability, so this
 * module (unlike admin-ui's `ratesApi.ts`) has no client-side capability
 * gate of its own; any authenticated refund user can call it, matching
 * every other `requestsApi.ts`/`reviewApi.ts` call already made from here.
 *
 * DRIFT NOTE (flagged in this task's implementation report): refund-api's
 * `rates/` module (T3/T4, specs/009-mileage-rate/tasks.md) is NOT YET
 * IMPLEMENTED as of this task — this worktree has no `refund-api/src/rates/`
 * at all. This module targets the documented CONTRACT (plan.md "## API
 * contracts"), the same "build against the contract, not a running service"
 * posture `requestsApi.ts`/`reviewApi.ts` already established in this file's
 * own lineage (see those files' own doc comments) — every test here mocks
 * `apiFetch`, none require a live refund-api.
 */

import type { Entity } from '../components/EntityBadge'
import type { Currency } from './money'
import { getJson } from './refundApi'

/**
 * `GET /rates/effective`'s response shape (plan.md "## API contracts").
 * `inEffect: false` (AC-2.2 — no rate entry configured for this entity, or
 * its earliest entry postdates this date) carries no rate fields at all —
 * the discriminated union makes that statically unrepresentable to read.
 */
export type EffectiveRate =
  | {
      entity: Entity
      date: string
      currency: Currency
      inEffect: true
      ratePerKmMicros: number
      ratePerKm: string
      validFrom: string
    }
  | { entity: Entity; date: string; currency: Currency; inEffect: false }

/**
 * `GET /rates/effective?entity=&date=` — resolves the per-km rate in effect
 * for one (entity, date) pair (AC-2.1/AC-2.3), for `MileageAmountField`'s
 * live recompute (AC-1.2/AC-1.3). `date` is `YYYY-MM-DD` (ISO date-only,
 * matching `RefundLine.date`'s own format already used verbatim elsewhere in
 * this app). Throws `ApiError` on a non-2xx response (`400` on a malformed
 * entity/date, plan.md) — the caller treats any rejection the same way, as
 * its own Fetch-error state (design.md: "no dedicated Retry button; the
 * field is live, editing anything re-triggers the fetch").
 */
export const getEffectiveRate = (entity: Entity, date: string): Promise<EffectiveRate> =>
  getJson<EffectiveRate>(`/rates/effective?entity=${encodeURIComponent(entity)}&date=${encodeURIComponent(date)}`)
