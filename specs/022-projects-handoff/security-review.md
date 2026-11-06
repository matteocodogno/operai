# Security review (design) — specs/022 referent read and ops-manager holders

Task T18 · reviewer: `wellforge:owasp-reviewer` · date: 2026-11-05 · scope: the contracts of
`tasks.md` § API contracts for auth `GET /authz/users/holders` (T20), crm-api
`GET /system/contacts` (T21) and the projects-api referent and pick parts (T23–T27), before
any of them was built (ledger D49). Written by the main loop from the reviewer's report (the
reviewer has no write tool).

**Verdict: PASS-WITH-CHANGES** — 0 critical · 0 high · 5 medium · 10 low. The design is
sound (live reads, scoped service credential, fail-closed picker). Every medium finding is
folded into `tasks.md` § API contracts and § Security rules (2026-11-05); no AC changed.

## Medium (folded in before T20, T21, T24, T26)

| # | Area | Problem | Contract change (where) |
|---|---|---|---|
| M1 | A01 / minimisation — `GET /companies/{id}/contacts` | Gated by `project:manage` under any entity with a client-chosen company id: a CRM contact directory for non-CRM users (company ids are listable through `GET /companies?q=`) | Removed; replaced by `GET /queue/{dealId}/contacts` and `GET /projects/{id}/purchase-order/contacts`, the company derived by the server (T24, T26) |
| M2 | A01 / minimisation — `GET /system/contacts` | One shape with email and phone in bulk mode makes a credential or route compromise a full contact export | Per-mode shapes with explicit `select` (bulk: id, names, job title; `ids`: the full display set), `ids` ≤ 20, id format checked, key-set contract test; `crm.contacts.read` for projects-api only (T21, T35) |
| M3 | A01 / privacy, TOCTOU — referent | Validated at set time, shown for ever: a contact later moved to another company would show to every access holder | The same predicate at read and set: exact id match and the project's / live deal's company; otherwise `referent: null`; id charset rule (T24, T26) |
| M4 | A01 / ADR-0047 — holders listing | The directory gate admits asset and deal managers without projects access; email and entity not needed | Gate `handoff:take`, own limiter, `no-store`, strict query, shape `{ id, name, unconditioned }`; ADR-0063 records the ADR-0047 amendment (T20, T34) |
| M5 | A02 / A04 — "live, never copied" | No `Cache-Control` in projects-api; an in-process cache habit (identities, 60 s) would keep an erased contact visible | No contact cache anywhere; `Cache-Control: no-store` on every referent / contact response; UI keeps it in memory only; no referent data in the system route, notification or logs (T26, T32, § Security rules) |

## Low (folded in or deferred)

- L1 One identical `referent_invalid` body for unknown / other-company / no-company; company
  check first; no echo — folded (T24).
- L2 Synthetic contacts in fixtures, examples and seeds — § Security rules.
- L3 Explicit field picking, never spreading a CRM item; crm-api explicit `select` — folded
  (T21, T26).
- L4 Holders evaluation mirrors `scopeFor` fail-closed; candidates must hold
  `projects:access`; the answerable pair pinned server-side — folded (T20).
- L5 `oversees` via `scopeFor(…).length === ENTITIES.length`, never `hasCapability`; the
  assignee read from the row and still holding `purchase-order:receive`; check-and-write
  under the version CAS; "All entities" label — folded (T24, T27, § Security rules).
- L6 Structured audit log lines for take, referent set / clear, pick — § Security rules.
  Per-viewer logging of referent reads: **deferred**.
- L7 Contact read only when a referent is set, in parallel, with the usual timeout — folded
  (T26). A per-caller limit on crm-api `/system/*`: **deferred**.
- L8 `truncated` on the bulk contacts mode — folded (T21).
- L9 Contact fields rendered as text; `mailto:` / `tel:` with a fixed scheme — § Security
  rules (T32).
- L10 An erased contact leaves an orphan opaque id on the PO — accepted (already in
  § Deferred).

## Answers recorded

- Name, job title, email and phone to every `projects:access` holder is accepted as the
  owner's decision (D49, Q4): an internal, admin-assigned audience within the same
  controller. Narrowing email and phone to manage holders, the project manager and the
  ops-manager remains an option for the owner, not a requirement.
- The admin override and the pick rule open no privilege-escalation path: picking a project
  manager confers no capability, and after the first pick any manage holder may change it
  (A34) — the restriction is a workflow rule, not a security boundary.

---

# Implementation review — before merge (2026-11-05)

Reviewer: `wellforge:owasp-reviewer` · scope: the code diff of `feat/projects-handoff` over
`feat/projects` (PR #7), triggered by `config/security-triggers.yml` (auth/**, token,
credential, jwt, permission, session, migrations).

**Verdict: PASS** — 0 critical · 0 high · 0 medium · 8 low. Every T18 medium (M1–M5) and
every folded low (L1–L9) is implemented as written; L6's per-viewer read logging and L7's
crm-api per-caller limit stay deferred as recorded above.

Lows (notes, not defects; candidates for a follow-up hardening bugfix):
1. `GET /queue` gated by `requireCapability(handoff:take)` (`hasCapability`, condition-blind);
   add a `takeScope(c).length > 0` check — `projects-api/src/queue/queue.routes.ts:55`.
2. The migration guard counts without a lock; prepend `LOCK TABLE "contract", "project" IN
   ACCESS EXCLUSIVE MODE;` — `prisma/migrations/20261105120000_purchase_order/migration.sql`.
3. One projects-api service token carries all five scopes for every target (ADR-0044/0049
   design); `crm.contacts.read` widens what a replay can reach — per-target narrowed tokens
   as a deferred option.
4. `redirect: "error"` missing on the crm, estimai and holders fetches
   (`projects-api/src/lib/crm.ts:77`, `estimai.ts:51`, `holders.ts:48`).
5. The `[uncaught]` handler logs the whole error object (`projects-api/src/index.ts:86`).
6. No per-caller limit on the ops-managers / contacts fan-out in projects-api (L7's other side).
7. projects-api drops crm's `truncated` on the company-contacts mode (picker silently capped
   at 500).
8. `no-store` missing on the holders route's 400/401; stale 021 `contract:bexio` rules not
   pruned by the seed; no audit line for refusals.
