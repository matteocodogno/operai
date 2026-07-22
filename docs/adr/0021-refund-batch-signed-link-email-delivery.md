# 0021 — Compiled-batch email delivery as an accounting-only app deep link: no raw presigned URL, no attachment, single distribution address

**Date:** 2026-07-19
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

**Amended by:** [ADR-0029](0029-batch-email-recipient-live-resolution-amends-0021.md)
(2026-07-22, `specs/011-refund-settings`) — Decision point 3 below ("Recipient is always exactly
the one configured distribution address … on every compile and every resend") is superseded: the
address is no longer a compile-time-frozen env var, it is now resolved **live** from an
admin-managed `refund_setting` at every send/resend attempt, and `compileBatch` no longer accepts
a recipient at all. Decision points 1, 2, and 4 below — the in-app deep-link design, the
`notify-api` template/channel shape, and the soft-failure/never-blocks-compilation posture — are
**unchanged** and remain fully in force. This ADR's `Status` stays `Accepted` per this
repository's convention (no ADR here is ever marked `Superseded`); read ADR-0029 alongside this
one for the current, accurate picture of recipient resolution.

---

## Context

Spec `specs/008-refund-monthly-processing` US-3 requires that, the instant a batch finishes
compiling, an email reaches accounting's mailbox carrying a way to reach the compiled PDF
(ADR-0019, ADR-0020) — durably, outside the app, so accounting isn't dependent on remembering to
log in and fetch it (AC-3.1). But AC-3.5 draws a hard line on *how*: the link "only ever resolves
to the PDF after the same accounting/`refund-admin` authorization check that gates opening the
batch in-app … and it expires after a short, bounded window … no standalone, unauthenticated, or
permanent access." AC-3.4 adds a second hard line: because a batch spans multiple employees'
financial data, the email goes **only** to a single configured distribution address, never to any
individual employee whose request is included, and never as a per-employee attachment or link.
The spec's Non-goals reinforce both: no binary PDF attachment (and no extension of `notify-api`'s
email channel to support one), and no per-employee individual extract.

`notify-api`'s only email path is `POST /system/emails` (ADR-0011) — a fixed, enum-templated,
escaped-HTML, 16 KiB-capped channel with no concept of a binary attachment at all, built
originally for invitation links. This plan needed to decide what the email body actually *is*: a
literal presigned S3 GET URL (ADR-0016's existing pattern for receipt attachments) would satisfy
"a link that reaches the PDF," but AC-3.5's own wording — "no standalone, unauthenticated …
access" — directly disqualifies a raw presigned URL, because a presigned URL is *by definition*
standalone and unauthenticated: anyone holding it, forwarded or leaked, can use it with no sign-in
and no authorization check at all, for as long as its (typically much longer than 60s) expiry
allows.

## Decision

We will deliver the compiled-batch email with an **in-app deep link** to `refund-ui`'s
`/refund/batches/:id` route — **not** a presigned S3 URL and **not** a binary attachment — sent
exclusively to the single deploy-configured accounting distribution address, and we will add one
new `notify-api` template plus a per-template `data` shape rather than extending the channel with
any attachment concept.

1. **The email body is an app URL, never a storage URL.** `refund-api`'s new
   `src/lib/notifyEmail.ts` calls `notify-api POST /system/emails` (`X-Internal-Token`, the same
   ADR-0011 shared-secret trust `refund-api` already uses for `/system/notifications`, ADR-0017)
   with `data.batchUrl = "<REFUND_APP_BASE_URL>/refund/batches/<id>"` — a link into the shell-hosted
   `refund-ui`, not a bucket URL. Opening it forces the suite's existing sign-in guard (ADR-0002)
   if the recipient isn't already authenticated, then the batch-detail page runs the same
   `request:review` capability check that gates opening any batch in-app (AC-2.3), and **only
   after that check passes** calls the authz-gated `GET /batches/:id/pdf-url`, which mints a fresh
   ~60s presigned GET (ADR-0016's existing pattern, reused unchanged). The "short, bounded window"
   AC-3.5 requires is realized by that post-authz mint, not by anything in the email itself — the
   deep link has no expiry of its own because it grants no access by itself.
2. **`notify-api` gains one new template and a per-template `data` shape, not attachment
   support.** `EMAIL_TEMPLATES` += `"refund_batch_compiled"`; `emails.schemas.ts`'s `data` becomes
   a discriminated union keyed on the sibling `template` field — the existing `invitation*`
   templates keep their unchanged `{inviteUrl,inviterName,expiresAt}` shape, `refund_batch_compiled`
   requires `{batchUrl, batchReference, cutoff, generatedAt, requestCount}`. Every field is
   HTML-escaped into a fixed template exactly as the existing invitation templates already are —
   no free-form body, no attachment field, no MIME-multipart concept added anywhere in the
   channel. English-only (Non-goal: no Italian for this feature, matching `refund-ui`'s existing
   v1 gap).
3. **Recipient is always exactly the one configured distribution address.** `to` is always
   `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` (a new validated-at-startup env var), never derived from
   any employee's email, never a per-request or per-owner value, on every compile and every resend
   (AC-3.4). This is enforced by construction — `notifyEmail.ts` has no code path that accepts a
   caller-supplied `to` at all, it always reads the one configured value. **Superseded by
   ADR-0029** (`specs/011-refund-settings`): the address is no longer a compile-time env var read
   fixed once per batch — it is now resolved live, from an admin-managed `refund_setting`
   (ADR-0027), at every send and resend attempt, and `compileBatch` no longer takes a recipient
   parameter at all. The single-recipient invariant itself (exactly one address, never derived
   from an employee) is unchanged; only *where that address comes from and when it's read* changed.
4. **Soft-failure posture, unchanged from ADR-0011.** `notifyEmail.ts` never throws; a Resend/
   network/non-2xx failure is caught, logged without financial/PII detail (batch id + status
   only), and the resulting `status`/`deliveryId` are persisted on the batch
   (`emailStatus`/`emailLastAttemptAt`/`emailDeliveryId`, AC-3.2) rather than surfaced as an
   error. Compile never blocks or fails on email failure (AC-3.1); mark-paid never requires a
   successful send first (AC-4.2). Resend (`POST /batches/:id/email`, AC-3.3) mints a fresh link
   and re-attempts delivery on demand, regardless of the batch's current status, without
   re-running compilation or touching the frozen request set/PDF.

## Options considered

### Option A — App deep link only, one new template, single distribution address (chosen)

Described above.

**Pros:**
- Directly satisfies AC-3.5's "no standalone, unauthenticated, or permanent access" — the email
  itself grants nothing; every actual access still passes through the same in-app authorization
  check as any other batch view
- Reuses `notify-api`'s existing channel shape unchanged — one more enum template and one more
  `data` variant, not a new attachment concept the channel has never needed to support
- The single-recipient invariant is structural (`notifyEmail.ts` has no parameter that could
  carry a different `to`), not merely a convention that a future caller could accidentally violate

**Cons:**
- The email itself is less immediately useful than a one-click-download link would be — the
  recipient must be signed into Operai and hold the `request:review` capability to actually reach
  the PDF, an extra step beyond "click the email"
- Requires `REFUND_APP_BASE_URL` to be correctly configured per environment (local/staging/prod)
  for the link to resolve anywhere real — a new env var alongside the existing
  `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`

### Option B — A raw presigned S3 GET URL in the email body, reusing ADR-0016's pattern directly (rejected)

Mint the ~60s presigned GET at compile time and put that literal URL in the email.

**Pros:**
- Genuinely one-click — no sign-in, no in-app navigation, works even for a recipient without an
  Operai account
- Reuses ADR-0016's existing presigned-GET minting code with zero new authorization plumbing

**Cons:**
- Directly violates AC-3.5's own wording: a presigned URL, once emailed, is inherently
  "standalone" and "unauthenticated" — anyone who receives, forwards, or has their mailbox
  compromised can use it with no further check, for as long as its expiry allows (and a
  practically useful email-delivery window is far longer than the 60s window used for in-app
  clicks, which is minted fresh on-demand — a URL baked into an email would need a much longer
  expiry to remain useful when actually read, directly undermining the "short, bounded window"
  requirement)
- A batch PDF aggregates multiple employees' financial data — leaking that link (an inbox
  compromise, a forwarded email, a mail-relay log) exposes materially more PII than a single
  receipt attachment's presigned URL would
- Rejected: fails the spec's own acceptance criterion outright, not a matter of preference

### Option C — Binary PDF attachment on the email itself (rejected)

Attach the compiled PDF bytes directly to the outgoing email via Resend's attachment support.

**Pros:**
- No link-resolution step at all — the artifact is immediately in the recipient's mailbox

**Cons:**
- Explicitly a Non-goal in the spec: "Binary PDF email attachments, or extending `notify-api`'s
  email channel to support them" is named as out of scope, and the plan's Constraints section
  confirms `/system/emails` "has no concept of a binary/PDF attachment, and this feature does not
  require one"
- Once attached, the PDF exists as a permanent, unauthenticated copy in every recipient mailbox
  (and every downstream backup/forward of that mailbox) forever — the opposite of AC-3.5's
  short-bounded-window requirement, with no revocation mechanism at all once sent
- Would require extending `notify-api`'s channel abstraction (ADR-0011) with an entirely new
  MIME/attachment concept for a single caller — disproportionate new surface for a feature the
  spec explicitly said not to build this way
- Rejected outright on both the spec's Non-goals and AC-3.5's own access-control requirement

### Option D — Per-employee individual delivery (separate email per included employee, with only their own lines) (rejected)

Instead of one email to accounting, send each employee a personal extract of their own included
lines.

**Pros:**
- Would give employees a direct payroll-adjacent confirmation via email, in addition to the
  existing in-app `paid` notification (US-5)

**Cons:**
- Explicitly a Non-goal: "Per-employee individual PDF extracts or per-employee email delivery of
  the compiled artifact" is named out of scope for this spec — a plausible future enhancement, not
  built here
- Would require an entirely different rendering/data-shaping path (a per-employee slice, not the
  full compiled document) and a second recipient-resolution mechanism (per-owner email, not the
  single configured address) — real new scope beyond what US-3 asks for
- Rejected as out of scope; US-5's existing in-app notification (ADR-0017) already gives
  employees their own paid confirmation without this

## Consequences

**Positive:**
- AC-3.5's access-control requirement is satisfied structurally — the email link alone can never
  reach the PDF; the same in-app authorization gate applies every time, with no separate
  "email-link" access path to keep in sync with the in-app one
- `notify-api`'s email channel gains one more template without ever growing an attachment concept
  it does not otherwise need — keeps ADR-0011's deliberately narrow, fixed-template, fully-escaped
  channel shape intact for every future caller too
- The single-recipient invariant (AC-3.4) is enforced by the absence of any alternative code path,
  not by a check that could be bypassed by a future change

**Negative / trade-offs:**
- Less immediately actionable than a one-click download — recipients must be signed-in Operai
  users holding the right capability, not merely holders of the email
- `refund-api` now depends on `REFUND_APP_BASE_URL` resolving correctly per environment for the
  link to be useful at all — a misconfigured value degrades the email to a dead or wrong link
  without failing the send itself (the URL is opaque to `notify-api`, which does not validate it)

**Risks:**
- **A misconfigured `REFUND_APP_BASE_URL` silently produces a broken deep link.** Mitigation:
  validated at startup like every other required env var (`process.exit(1)` on missing), though
  correctness of the *value* — not just its presence — is a deploy-checklist concern, not
  something `refund-api` can verify at boot.
- **`refund-api` now hard-depends on `notify-api`'s `/system/emails` in addition to
  `/system/notifications`** (plan Risk R9). Mitigation: both calls are best-effort and never block
  compile/mark-paid; only in-app delivery-status display degrades on a `notify-api` outage.
- **Cross-entity PII exposure through a global batch's PDF**, reachable by any `request:review`
  holder who follows the link and passes the in-app check — a named, accepted v1 trade-off (see
  ADR-0020/the plan's Resolved Decision D1), bounded here by the fact that the email itself never
  carries the PDF or a usable link on its own, only every batch-read still requires the same
  capability check as any other in-app view.

## Compliance notes

- GDPR/nLPD impact: medium — the compiled PDF aggregates multiple employees' financial/PII data;
  this decision's core purpose is precisely to avoid that aggregate ever becoming reachable via an
  unauthenticated email artifact (link or attachment), keeping every actual access behind the
  same in-app authorization as any other batch view.
- Data residency: unaffected — the email itself carries no financial data, only a link and
  metadata (batch reference, cutoff, timestamp, request count); the PDF stays in the EU bucket
  (ADR-0016/ADR-0019) regardless of where the email transits.
- Audit trail: the email send/resend itself is not a separately audited event (mirroring
  ADR-0011's existing stance that delivery status lives in `notify-api`'s own `EmailDelivery`
  record, not the application audit log); the compile/mark-paid/discard actions that surround it
  are covered by ADR-0022.

This decision **extends** ADR-0011 (the notify-api email channel and internal-token trust this
decision reuses verbatim for a second template, without extending it for attachments) and reuses
ADR-0016's presigned-GET-after-authz pattern for the actual PDF access step the deep link leads
to, deliberately declining to reuse ADR-0016's presigned-URL-in-hand pattern for the *email body*
itself. It also assumes ADR-0020's batch-read authorization model (capability-gated, not
entity-scoped — the plan's Resolved Decision D1) as the check the deep link's landing page
performs. **Decision point 3's recipient-sourcing mechanism (compile-time env-var freeze) is
superseded by ADR-0029**, which resolves the same single-recipient invariant live against
ADR-0027's admin-managed `refund_setting` instead.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
