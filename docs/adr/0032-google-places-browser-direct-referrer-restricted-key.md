# 0032 — Google Places API (New) is called browser-direct, with a referrer-restricted key — never proxied through `auth`

**Date:** 2026-08-04
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/012-employee-address` (US-2/US-3) requires live, forgiving address suggestions as
an admin types, biased toward Switzerland and Italy (a Constraint, not a vendor-neutral
requirement — the calling brief names Google Maps explicitly) but never blocking a save
if the suggestion service is slow, down, or rate-limited (AC-3.2). `admin-ui` is a
federated remote (ADR-0006), mounted inside the **shell's** document at runtime — it has
no backend of its own — while `auth` is the suite's identity/session/authorization
service, already on the critical path of every authenticated request across every tool.
Two shapes were live candidates for where the third-party call originates: the admin's
browser calling Google directly, or `auth` (the only service in the monorepo positioned
to hold a durable secret safely) proxying the call server-side. The choice has real,
divergent consequences for billing correctness (Google's Autocomplete session-token
model requires N keystroke calls plus one Details call to be billed as a single session —
gotten wrong, billing silently reverts to per-request), for `auth`'s own availability
(any synchronous outbound dependency added to `auth` becomes a dependency of every tool
in the suite, since every tool authenticates through it), and for the suite's practice of
minimizing what third-party data ever reaches `auth`.

## Decision

We will call **Google Places API (New)**, via the Maps JavaScript API
(`AutocompleteSuggestion.fetchAutocompleteSuggestions()` for suggestions,
`place.fetchFields({ fields: ['addressComponents','location'] })` for details),
**directly from the admin's browser**, using a public, referrer-restricted,
API-restricted, quota-capped key owned by `admin-ui` (`VITE_GOOGLE_MAPS_API_KEY`).
`auth` gains no new endpoint, no new outbound dependency, and no new secret. Four rules
are established as durable, suite-wide posture, not just this feature's local choice.

1. **No third-party proxy inside the identity service, ever.** `auth` sits on the
   critical path of the entire suite — every tool authenticates through it. Routing a
   third-party lookup (Google, or any future third-party enrichment) through `auth` would
   put that third party's latency and failure modes on the availability of every tool in
   Operai, not just the one feature that needs it. This applies beyond Google Maps: any
   future optional third-party enrichment anywhere in the suite must originate from the
   consuming remote's own browser context or its own backend, never from `auth`.
2. **A federated remote's referrer restriction is the SHELL's origin, not the remote's
   own.** Because `admin-ui` runs as a Module Federation remote inside the shell's
   document (ADR-0006), the `Referer` header on every Google call is the **top-level**
   URL — the shell's origin (`https://operai.welld.io/*` in production, plus dev/preview
   patterns) — never `admin-ui`'s own origin. This is a durable, non-obvious rule for
   every future browser-direct third-party integration added to a federated remote: the
   key restriction list must always be built from the shell's origins, and getting this
   wrong fails **100% silently** under this feature's own AC-3.2 graceful-degradation
   posture (see Risks).
3. **`locationBias` for regional preference, never `includedRegionCodes`.**
   `includedRegionCodes` is a **restriction** — it makes every address outside the listed
   regions unreachable, which would directly violate AC-2.4 ("the admin can still scroll
   to and select an address in ANY other country"). `locationBias` is a ranking
   preference only. This suite's rule for any future geographically-biased third-party
   query: bias parameters are acceptable defaults, restriction parameters require an
   explicit acceptance criterion authorizing them.
4. **Silent graceful degradation is the standing posture for optional third-party
   enrichment.** A Google outage, timeout, or rate-limit never surfaces an error banner
   and never blocks the underlying save — the address field degrades to a plain manual
   form with no suggestion affordance, one `console.warn`, nothing more. This generalizes:
   any future optional (non-authoritative) third-party enrichment in the suite must be
   designed so its own unavailability is invisible to the end user and never blocks the
   primary action it was meant to assist.

## Options considered

### Option A — Browser-direct, referrer-restricted key owned by `admin-ui` (chosen)

Described above.

**Pros:**
- The JS SDK mints and consumes `AutocompleteSessionToken` correctly by construction — N
  keystroke calls plus one Details call bill as a single "Autocomplete (per session)"
  SKU with no manual session-token bookkeeping
- A Google outage is purely client-side: `AbortController` plus a bounded timeout,
  degrade to manual entry, **zero server impact** — `auth` never becomes a dependency of
  an optional third-party feature
- The key's exposure risk is quota/billing theft only, not data — it is public by design,
  restricted by referrer + API-restriction + a daily quota cap + a budget alert
- admin-ui owns its own third-party UX dependency, the same ownership boundary every
  other frontend concern in the suite already follows

**Cons:**
- The GDPR delta against a server-side proxy is real, if marginal: Google observes the
  admin's IP/browser context in addition to the typed fragment, not just an EU server IP
  — mitigated by lazy-loading the SDK only on first focus of the address field, sending
  only the typed fragment (no user id, email, or employee identity), and the section
  being admin-only (a small, known population)
- A misconfigured referrer restriction (listing `admin-ui`'s origin instead of the
  shell's) fails **every** request, and — because of Decision point 4's own
  graceful-degradation posture — fails invisibly; this is a genuine, named operational
  risk (R2 in the specs/012 plan) that a server-side proxy would not have had

### Option B — `auth` proxies the Google call server-side (rejected)

`auth` gains a new authenticated endpoint that forwards the admin's typed fragment to
Google using a server-side, IP-restricted secret key.

**Pros:**
- The secret key is genuinely server-side and IP-restricted — strictly better than a
  public browser key on the key-exposure axis alone
- Marginally better GDPR posture: Google sees the request from an EU server IP rather
  than the admin's own browser context (the address text itself still reaches Google
  either way)

**Cons:**
- Correct per-session billing requires generating a session-token UUID, threading it
  through every proxied keystroke call, and terminating it on the Details call **by
  hand** — get this wrong and billing silently reverts to per-request, a class of bug
  with no functional symptom, only a cost one
- A Google outage or slow response now consumes `auth` connections and time budget — the
  identity/session/authorization service for the **entire suite** degrades because a
  maps lookup is slow, an unacceptable failure mode given `auth` sits on every tool's
  critical path
- Turns `auth` into a free, authenticated text-search proxy for any signed-in user unless
  separately rate-limited — exactly the responsibility creep ADR-0023 already pushed
  back on when it kept refund-domain computation out of `auth`, now generalized to any
  third party
- Rejected: strictly worse on the one axis (availability) this suite already treats as
  non-negotiable for `auth`

### Option C — The legacy `Autocomplete` / `AutocompleteService` classes (rejected)

Use Google's older, previously-standard JS Autocomplete classes instead of Places API
(New)'s `AutocompleteSuggestion`/`fetchFields` surface.

**Pros:**
- Marginally more third-party example code and Stack Overflow coverage exists for the
  legacy surface

**Cons:**
- Google closed the legacy classes to new customers on 1 March 2025 — building new code
  against them means building on a dead surface with no forward path
- Rejected: a closed-to-new-customers API is not a viable foundation for a feature being
  built today

### Option D — Google's `PlaceAutocompleteElement` web component (rejected)

Use Google's pre-built, DOM-owning autocomplete input element instead of a custom
`<input>` + suggestion list built against the raw service calls.

**Pros:**
- Least first-party code to write and maintain — Google owns the rendering entirely

**Cons:**
- Renders Google-owned DOM inside the page, directly fighting this repo's design-system
  and accessibility posture (every new interactive element must be a native
  `<button>/<select>/<input>/<a>`)
- Makes AC-2.3 ("pre-fills, never locks") and AC-3.2 ("no stuck-loading state")
  behaviours Google's to define, not this codebase's to test — an unacceptable loss of
  control over acceptance-criteria-critical behaviour
- Rejected: incompatible with the suite's a11y/design-system discipline and with owning
  the exact failure-mode behaviour AC-3.2 requires

### Option E — Store the key in `shell/session`, mirroring ADR-0023's `getRefundApiBaseUrl()` getter (rejected)

Have the shell own and expose `getGoogleMapsApiKey()` the same way it exposes
`getAuthBaseUrl()`/`getRefundApiBaseUrl()`.

**Pros:**
- Consistent with the existing precedent of the shell owning suite-wide, per-environment
  configuration getters

**Cons:**
- That precedent exists specifically for **service origins the shell configures for the
  whole suite** — `auth`, `refund-api`. A third-party credential used by exactly one
  component of one remote does not belong in a module every remote imports; doing so
  would widen `shell/session`'s blast radius (a leaked or rotated key now touches a
  module every tool depends on) for no shared benefit
- Rejected: `admin-ui`'s own `.env`/Vercel project env is the correctly-scoped home for a
  credential only `admin-ui` uses

## Consequences

**Positive:**
- `auth`'s availability is completely decoupled from Google's — an outage, slowdown, or
  quota exhaustion on the Places API is invisible to every other tool in the suite and
  degrades exactly one admin-ui section to manual entry
- Session-token billing correctness is structural (the SDK's own responsibility), not a
  hand-maintained proxy implementation detail that could silently regress
- Establishes a durable, generalizable rule for the suite's next optional third-party
  integration: browser-direct from the consuming remote, referrer-restricted to the
  shell's origins, bias-not-restriction parameters only, silent degradation on failure

**Negative / trade-offs:**
- The referrer-restriction rule (shell's origin, not the remote's) is genuinely
  non-obvious and fails **invisibly** if gotten wrong, by design of the same
  graceful-degradation posture this ADR establishes as correct — the mitigation is
  operational (an explicit `infra/README.md` provisioning note and a dev-only
  `console.warn` on `REQUEST_DENIED`), not structural
- The public key carries a genuine, accepted billing-theft risk if referrer restrictions
  are somehow bypassed by a non-browser client — bounded to quota/cost, never data, by
  the API-restriction (Places API New + Maps JS API only) and a hard daily quota cap
- Google still receives the typed address fragment plus the admin's IP/browser context —
  a real, if minor, GDPR delta against a server-side-proxy design, accepted and bounded
  by lazy-loading on first focus and the admin-only surface

**Risks:**
- **Referrer list built from the wrong origin (R2).** Listing `admin-ui`'s own origin
  instead of the shell's fails 100% of requests, invisibly, by design of AC-3.2's
  degrade-silently posture. Mitigation: called out explicitly in `infra/README.md`'s
  provisioning steps; a post-provisioning check (load the **deployed shell**, confirm a
  `places.googleapis.com` 200 in devtools) plus a dev-only `console.warn` on
  `REQUEST_DENIED`.
- **`includedRegionCodes` one keystroke away from `locationBias` (R3).** Would silently
  make non-CH/IT addresses unreachable. Mitigation: `googlePlaces.test.ts` asserts the
  constructed request object **lacks** `includedRegionCodes`, called out as a MUST-NOT in
  the request-contract table.
- **Public-key billing/quota theft (R4).** Referrer restrictions are spoofable by a
  non-browser client. Mitigation: API-restriction to Places API (New) + Maps JS API
  only, a hard daily quota cap, a budget alert — accepted as a billing risk, never a data
  risk, since the key grants nothing but address lookups.
- **Legacy "Places API" enabled instead of "Places API (New)" (R6).** A project with only
  the old API enabled returns `REQUEST_DENIED` for the new endpoints. Mitigation: an
  explicit early provisioning check before any UI work begins.

## Compliance notes

- GDPR / data-protection impact: low-to-medium — the typed address fragment (no user id,
  email, or employee identity) reaches Google from the admin's browser, along with the
  admin's own IP/browser context, while the admin is actively typing in the address
  field. Bounded by lazy-loading the SDK only on first focus (an admin who never opens
  the address section causes zero contact with Google) and by the section being rendered
  only for admins (AC-4.2) — a small, known population.
- Data residency: this is the one deliberate, named exception to the suite's EU-only
  outbound-transfer posture — the Google Places lookup is a non-EU-processor transfer,
  explicitly called out for the specs/012 owasp review rather than left for the reviewer
  to discover; no persisted data leaves the EU (the address itself is stored only in
  `auth`'s EU-region PostgreSQL, per ADR-0031).
- Audit trail: not applicable — a suggestion lookup is a transient UX interaction, never
  persisted, and carries no audit obligation distinct from the address save itself
  (governed by ADR-0033).

This decision **extends** ADR-0006 (Module Federation topology — the reason a referrer
restriction must target the shell's origin, not the remote's) and reaffirms the
responsibility-boundary reasoning ADR-0023 already established for keeping cross-domain
computation out of `auth` — generalized here from "another Operai domain service" to "any
third party." It is a deliberate **contrast** with ADR-0023's `getRefundApiBaseUrl()`
shell-owned-getter pattern (Option E above): that precedent is for suite-wide service
origins, not a single component's third-party credential. It establishes the suite's
first recorded posture for browser-direct third-party API integration, intended for reuse
by any future optional third-party enrichment feature.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
