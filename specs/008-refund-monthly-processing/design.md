---
spec: 008
status: draft
---

# Design: Refund monthly processing — PDF compilation, email delivery & "mark as paid"

Component library in use: **Tailwind CSS 4** utility classes driven by the federated
`shell/tokens.css` `@theme` block — unchanged from `specs/007-refund-service/design.md`
(confirmed again by reading `refund-ui/src/components/*.tsx`, all of which still style via
`var(--text)`/`var(--acc)`/`var(--grn)`/`var(--red)`/`var(--soft)`/`var(--muted)`/`var(--rule)`/
`var(--ink)`/`var(--ink-soft)`/`var(--disp)`/`var(--mono)`/`var(--body)`, no Mantine/MUI/Chakra/
shadcn dependency in `refund-ui/package.json`).

**This document's reuse vocabulary differs from 007's on purpose.** 007 was refund-ui's *first*
screen set, built from nothing, so every reusable pattern had to be **ported** — re-authored
file-by-file from `admin-ui`/`estimai-ui` because Module Federation (ADR-0006) forbids importing
another remote's source. 008 extends the **same already-built `refund-ui` app** in place — there
is no MF boundary between this feature's new screens and 007's existing components. So reuse here
is genuine, same-module reuse, not porting:

- **Reuse (as-is)** — an existing `refund-ui` component/lib imported and used unchanged.
- **Reuse (extended)** — an existing component/page gains a new prop, variant, or render branch;
  every existing call site is untouched (the same backward-compatible-extension discipline 007's
  own `ConfirmDeleteModal` → `tone` prop already established).
- **NEW** — no existing `refund-ui` (or, failing that, `admin-ui`) shape fits; a new file.

---

## Flows

Each flow lists entry → steps → success/error exits, with US/AC references. F1–F4 and F6/F8 are
accounting flows (extending 007's F5/F6 "accounting" role); F5 is the employee side (extending
007's F3); F7 is a no-new-UI cross-reference, mirroring 007's own F7/F4 treatment of actions with
no dedicated screen.

### F1 — Accounting compiles this cycle's approved requests into a batch (US-1: AC-1.1–1.5, 1.8–1.10)

Entry: **Screen B1 (Batch history)** → "+ Compile new batch".

1. `/refund/batches/new` (**Screen B2**) loads with the cutoff field pre-filled to the current
   instant (AC-1.1's "defaults to the current moment") and immediately fires
   `GET /batches/candidates?cutoff=<that instant>` — a dry-run, no-writes preview (plan.md's
   `CandidatePreview` shape). This satisfies AC-1.4 up front: the accounting user sees the
   candidate set — and, crucially, sees an EMPTY one — before ever clicking Compile, not after a
   failed attempt.
   - Plan.md's own UI-architecture note labels this preview step "(US-2)"; spec.md's US-2 ACs
     (2.1–2.3) are actually about inspecting an ALREADY-COMPILED batch (Screen B3), not this
     pre-compile dry run. This design treats the preview as an AC-1.4/1.9-serving UX safeguard
     that plan.md's own `GET /batches/candidates` endpoint makes possible — not a US-2 surface —
     and flags the citation mismatch in Gaps below rather than silently relabeling plan.md.
2. The accounting user may edit the cutoff (a native `<input type="datetime-local">`, labelled,
   no placeholder-as-label) and click **"Preview"** to re-fetch. **WYSIWYG rule:** whatever cutoff
   value produced the preview currently on screen is exactly the cutoff value `POST /batches`
   sends — the field is not silently re-resolved to "now" again at compile time, so the set the
   user reviewed is the set that gets compiled (see Gaps — this is a deliberate consistency
   choice, not something plan.md specifies either way).
3. **Screen B2, populated (P):** `BatchEmployeeGroupList` (mode `preview`) renders one group per
   employee — name/email, request count, per-currency subtotals (`BatchSubtotalsPanel`) — mirroring
   AC-1.6's own "per-employee, per-currency-subtotalled" PDF layout, so the in-app preview reads as
   a rehearsal of the document itself. An overall per-currency total sits above the groups. "Compile
   this batch" is enabled.
4. **Screen B2, empty candidate set (E — the compile-empty-set refusal, AC-1.4):** "No approved,
   unbatched requests are eligible as of this cutoff." — a real, successful, empty result (mirrors
   007's Screen A1 "Nothing awaiting your decision" reasoning: not an error, not a permission
   issue). "Compile this batch" is **disabled**, with the same inline explanation — never a doomed
   `POST /batches` that the server would 422 anyway (mirrors 007's F2 step 1 "the button is
   disabled … rather than allowing a doomed API call").
5. A request whose every line was approved at $0 (AC-1.9) appears in the candidate set on exactly
   the same terms as any other — `BatchSubtotalsPanel`/`formatMoney` render `0,00 <currency>`
   like any other amount, no special-casing anywhere in the UI.
6. **"Compile this batch"** → a confirm step, reusing `ConfirmDeleteModal` directly with
   `tone="positive"` (the same extension 007's `ApproveDialog` already introduced, applied inline
   here the way 007's own "Delete request" called `ConfirmDeleteModal` directly rather than via a
   wrapper — this dialog's copy is used nowhere else, so a dedicated wrapper file isn't warranted):
   "Compile N request(s) as of <cutoff> into a new batch?" Confirming → `POST /batches`.
   - **201** → navigate to **Screen B3** (`/refund/batches/$id`) for the new batch, carrying a
     one-shot `confirmation` search param ("Batch compiled — N request(s), PDF ready") — the exact
     same `validateSearch` + read-and-strip-once technique 007's `/review` route already
     established for Approve/Reject, applied here to a **detail** route instead of a list route
     (see Gaps — a new-but-consistent application of an existing pattern).
   - **422** (a race: another accounting user compiled the same candidates between this screen's
     preview and this click) → the confirm dialog's own inline error slot (`ConfirmDeleteModal`'s
     `errorMessage`, not a `GuardrailDialog` — this isn't "already decided", it's "changed under
     you"): "This candidate set changed since you last previewed it. Refresh and try again." The
     dialog stays open with Confirm re-enabled only after the caller re-runs the preview (B2
     reloads its candidate set on dialog-cancel so step 3/4 reflects the new reality).
   - **403** (AC-1.8, no `request:review`) — see Screen B2's PD state below; unreachable via the
     normal UI (Screen B1's own "+ Compile" is itself gated, see F8), but a defense-in-depth direct
     URL still resolves to `PermissionDenied`, mirroring 007's Screen A1 reasoning verbatim.

### F2 — Accounting inspects a batch, downloads the PDF (US-2: AC-2.1–2.3)

Entry: Screen B1 row, a fresh compile's redirect (F1 step 6), or the compilation email's deep
link (F3).

1. **Screen B3** shows the batch header — `BatchStatusBadge`, cutoff, generation timestamp,
   generating user's email, and the batch reference (the batch `id`, shown as a small monospace
   chip — plan.md's `BatchDetail`/email-template `batchReference` field is the same `id`, no
   separate reference number exists on the wire) — plus overall per-currency totals
   (`BatchSubtotalsPanel`) and `BatchEmployeeGroupList` (mode `detail`): the SAME per-employee,
   per-currency grouping as the preview, but now each group's rows are real, persisted requests
   (id, `RequestStatusBadge`, per-currency subtotal) that link to `/refund/review/$id` — AC-2.1's
   "full list of included requests grouped by employee".
2. **"Download PDF"** — a NEW `BatchPdfLink`, click → mint → open, following `AttachmentDownloadLink`'s
   exact contract (`GET /batches/:id/pdf-url`, then `window.open(url, '_blank', 'noopener,noreferrer')`)
   rather than reusing the `pdf.url` embedded in the initial `GET /batches/:id` response — that
   embedded URL is only ~60s fresh (plan.md), and a user may sit on this screen far longer before
   clicking; re-minting on every click guarantees the link is never stale regardless of dwell
   time. The browser's native PDF viewer is the "preview" AC-2.1 asks for (opening the PDF in a
   new tab) — no in-app PDF embed/viewer is built (see Component inventory — not designing a
   viewer no AC calls for).
3. Clicking a request row (AC-2.2) opens `/refund/review/$id` — the SAME `ReviewDetailPage` 007
   already built, unchanged entity-scope/ownership rules (007's own AC-6.4/6.5, reused verbatim
   per spec's AC-2.2): a batch's membership neither widens nor narrows who can open that specific
   request. `ReviewDetailPage` gains a `paid` render branch (F4 step 4) for when the batch (and
   therefore this request) has since been marked paid.
4. **L:** `SkeletonListRows` while `GET /batches/:id` loads.
5. **Err:** `ErrorBanner` + Retry (network/5xx).
6. **NF:** a genuinely nonexistent batch id → the same neutral "doesn't exist" copy + back-link
   convention as 007's Screen R2/A2 NF states — but note the REASON differs: 007's NF also covers
   entity-scope denial (AC-6.4); batch reads are explicitly **not** entity-scoped (plan.md's
   Resolved decision D1 — any `request:review` holder can open any batch regardless of their own
   scope), so a batch's NF state is purely "this id doesn't exist," never a scope-narrowing case.
7. **PD:** no `request:review` at all (AC-2.3) → `PermissionDenied`, no Retry — same defense-in-depth
   posture as every other accounting screen (reachable via direct URL even though Screen B1's own
   entry point, and the shell's suite-level nav, already hide it for non-accounting users).
8. A batch of ANY status (`compiled`/`paid`/`discarded`) renders this exact same inspection layout
   — AC-1.10/AC-6.3's "retained/inspectable regardless of outcome" — only the header's status
   badge, the presence of `paidAt`/`paidBy` or `discardedAt`/`discardedBy`, and the availability
   of Mark-as-paid/Discard (F4/F6, `compiled`-only) change.

### F3 — Compilation email delivered, and re-sendable (US-3: AC-3.1–3.5) — mostly cross-reference

No dedicated screen for the SEND itself (it's automatic, server-side, on compile — AC-3.1); this
flow is Screen B3's **email status + Resend** affordance (AC-3.2/3.3) plus the deep-link landing
behavior already described in F2.

1. Screen B3's header area shows the batch's current email delivery status as plain text next to
   a small indicator: "Email: Sent" (`--grn`) / "Email: Failed" (`--org`, matching `ErrorBanner`'s
   alert tone) / "Email: Not yet attempted" (`--muted`, the rare pre-first-attempt edge case) —
   AC-3.2's "visibly shown" requirement, on every batch regardless of status.
2. **"Resend email"** — visible and enabled on a batch of ANY status (AC-3.3: "resend is available
   regardless of the batch's current status", including `paid`/`discarded`) → `POST
   /batches/:id/email`. Feedback is a **`ToastBanner`** (tone `success`/`error`), the one place
   this feature deliberately breaks from 007's "no toasts for lifecycle actions, only inline
   `aria-live`" rule — because, exactly like 007's own later auto-save amendment, this is a
   repeatable, non-navigating, low-ceremony confirmation ("email resent") rather than a one-way
   lifecycle transition, the same distinction 007's Amendment (2026-07-17) already draws for
   auto-save. On success the batch reloads so the displayed `emailStatus`/timestamp reflect the
   fresh attempt.
3. AC-3.4/3.5 (recipient is only the configured distribution address; the link resolves through
   app-authz, not a standalone/permanent URL) are entirely server-side/email-template concerns —
   refund-ui adds no UI surface for them beyond the deep link already landing on the
   authz-gated Screen B3 (F2), consistent with plan.md's Resolved decision D2.

### F4 — Accounting marks a compiled batch as paid (US-4: AC-4.1–4.4)

Entry: Screen B3, a `compiled` batch, `request:approve`-holding accounting/`refund-admin` user.

1. **"Mark as paid"** renders only while `status === 'compiled'` — structurally absent (not
   disabled-and-explained) once `paid`/`discarded`, the exact "immutability enforced by omission"
   convention 007's design.md already establishes for a decided request's controls.
2. Click → **`MarkPaidDialog`** (NEW — see Component inventory for why this can't be a
   `ConfirmDeleteModal` extension). It shows: the batch's request count and per-currency totals
   (so the user isn't confirming blind — they see exactly what they're about to finalize), the
   current email delivery status as an FYI line ("Email: Failed — you can still mark this batch
   paid", directly answering AC-4.2's "provided they can see that status to act with full
   information"), explicit consequence copy ("This will mark N request(s) as paid, atomically.
   This cannot be undone — there is no way to reverse a paid batch."), and a REQUIRED
   acknowledgement checkbox ("I confirm these requests have been paid through payroll") gating the
   Confirm button — see Accessibility for the exact keyboard contract.
3. Confirm → `POST /batches/:id/mark-paid`.
   - **200** → the batch reloads in place (no navigation — the accounting user stays on B3,
     mirroring F6's discard behavior below): `BatchStatusBadge` flips to `paid`, `paidAt`/`paidBy`
     appear, Mark-as-paid/Discard disappear, every request row's own `RequestStatusBadge` (in the
     `detail`-mode `BatchEmployeeGroupList`) flips to `paid`. An `aria-live="polite"` confirmation
     ("Batch marked as paid — N request(s) updated") fires and focus moves to the status heading —
     the exact `justTransitioned` + heading-focus technique `RequestDetailPage`/`ReviewDetailPage`
     already use for submit/withdraw/approve/reject.
   - **409** (AC-4.3 — already `paid`/`discarded`, a race) → `GuardrailDialog`: "This batch has
     already been resolved and can no longer be marked as paid." → acknowledging reloads B3 so it
     shows the real, current terminal state.
   - **403** (AC-4.4, missing `request:approve` specifically — a currently-hypothetical case per
     plan.md's Resolved decision D3, since `accounting`/`refund-admin` always bundle
     review+approve today) → the dialog's own inline error slot, same as F1's 422 handling — not a
     full-page `PermissionDenied` (the rest of B3 is legitimately still viewable).
4. Once `paid`, an included request's `ReviewDetailPage`/`RequestDetailPage` render a `paid`
   branch (F5) — Screen B3 itself never repeats per-line requested/approved detail beyond what
   `BatchEmployeeGroupList`'s row already shows (id, status, subtotal); "inspect this one request
   fully" is always a click-through to `/refund/review/$id`, not duplicated inline.

### F5 — Employee sees their request marked paid (US-5: AC-5.1–5.5) — extends 007's F3

Entry: Screen R1 (My requests), or the notify-center push's `link.href` (`/refund/requests/:id`,
unchanged from 007's F7 mechanics — only the copy is new, server-side).

1. `RequestDetailPage` gains a **`paid`** render branch, sibling to the existing
   `draft`/`submitted`/`approved`/`rejected` branches (AC-5.2's "clearly marked paid, distinct
   from approved/rejected/submitted"): `RequestStatusBadge` shows the new `paid` variant (◆,
   `--grn` — see Component inventory for why it's a distinct glyph from `approved`'s ✓ despite
   sharing the same "positive/success" green), a "Paid on <date>" line reads `paidAt`
   (AC-5.2's "see when it was paid").
2. Per-line requested-vs-approved detail (AC-5.4) is UNCHANGED — the `paid` branch reuses
   `ExpenseLineRow` in `readOnlyApproved` mode exactly as `approved` already does (same lines, same
   `SubtotalsPanel showApproved`), because reaching `paid` adds a fact (it was paid, and when) on
   top of the already-final approved figures, it doesn't alter them.
3. `MonthlyProcessingNote` is **structurally absent** from the `paid` branch (AC-5.3) — not
   conditionally hidden, simply never rendered in that branch's JSX, the identical "structurally
   absent, not hidden" discipline 007's design.md already mandates for `draft`/`submitted`. No
   batch composition (id, other employees, other requests) is ever rendered on the employee side —
   `RequestDetailPage`'s data never needs to carry a `batchId` to the employee UI at all (see
   Gaps — worth confirming the wire contract genuinely omits it for the employee-facing `GET
   /requests/:id`, not just "the UI chooses not to render a field that's there").
4. No "+ New request" link on `paid` (mirrors `approved`'s exclusion — a paid request needs no
   corrective follow-up, same reasoning 007 gives for why only `rejected` offers that link).
5. AC-5.1's in-app push (notify-center) is entirely `notify.ts` → `POST /system/notifications` →
   the shell's existing bell/`ToastHost` (ADR-0009) — no new refund-ui surface, exactly 007's own
   F7 cross-reference treatment.
6. AC-5.5 (non-owner, non-accounting access denial, unchanged for `paid`) needs no new UI logic —
   the existing NF state (007's F2 step 5) already covers "record exists but caller has no access"
   uniformly across every status value, `paid` included.

### F6 — Accounting discards a compiled batch before it's paid (US-6: AC-6.1–6.3)

Entry: Screen B3, a `compiled` batch.

1. **"Discard batch"** renders only while `status === 'compiled'` (same structural-omission rule
   as Mark-as-paid, F4 step 1) — a `paid` batch never shows this control at all (AC-6.2), not a
   disabled one (the server's 409 is defense-in-depth, not the primary guard).
2. Click → `ConfirmDeleteModal` used directly (default `tone="destructive"`, no extension needed —
   this IS a "does this get voided, permanently" question, the component's original semantics):
   "Discard this batch? Its N request(s) will be released and become eligible for a future
   compilation. The batch's own record remains visible in history. This cannot be undone." →
   confirm → `POST /batches/:id/discard`.
   - **200** → batch reloads in place (no navigation, same as Mark-as-paid): `BatchStatusBadge`
     flips to `discarded`, `discardedAt`/`discardedBy` appear, Mark-as-paid/Discard disappear,
     every included request's row now shows its released `approved` status again (AC-6.1's
     "released back into the eligible candidate pool") — `aria-live` confirmation + heading focus,
     same technique as F4.
   - **409** (AC-6.2, already `paid`/discarded again) → `GuardrailDialog`, same copy/behavior as
     F4's 409 case, worded for "resolved" generically (a single shared guardrail message serves
     both Mark-as-paid's and Discard's terminal-CAS race, since both boil down to "someone else
     already closed this batch out").
3. A discarded batch's own history entry (AC-6.3) needs no separate UI — it's the SAME Screen B3
   inspection view (F2), just with `discarded`'s badge/timestamps instead of `compiled`'s
   actionable state; `BatchEmployeeGroupList` still shows every request that WAS in it (from the
   frozen `RefundBatchItem` set plan.md describes), even though those requests are no longer
   "currently claimed" by this batch.

### F7 — Audit trail of monthly processing actions (US-7) — cross-reference, no new UI

No dedicated screen, mirroring 007's own treatment of its audit-trail user story (US-8, that
design.md's F7/Gap #2): no AC in this spec asks for an in-app viewer over `RefundAuditEntry`
rows — US-7's ACs are entirely about the record being captured (AC-7.1) and immutable (AC-7.2),
not about anyone browsing it. This design adds nothing here, consistent with not inventing scope
007 itself deliberately declined to build.

### F8 — Accounting reviews the history of past compilation batches (US-8: AC-8.1–8.3)

Entry: **Screen B1** (`/refund/batches`), reached from the shell-nav-adjacent `RefundShell` link
(see Component inventory — `RefundShell` gains a third nav item).

1. Screen B1 lists EVERY batch regardless of status (AC-8.2 — never filtered to only `compiled`),
   each row: cutoff, `BatchStatusBadge`, request count, per-currency totals (condensed, mirroring
   007's Screen R1/A1 row convention of a compact `formatSubtotalsPreview`-style join — here a NEW
   `formatBatchSubtotalsPreview` since the batch subtotal shape carries only one figure per
   currency, not requested-vs-approved — see Component inventory), and a compact email-status
   indicator. No pagination — `GET /batches` is a bare array in plan.md's contract, the identical
   "renders every row it gets" posture 007's Gap #6 already established for `GET
   /requests`/`GET /review/requests`.
2. Clicking a row opens Screen B3 (F2).
3. **"+ Compile new batch"** (top-right, same placement convention as every other list screen's
   "+ New X") opens Screen B2 (F1) — visible regardless of caller's exact capabilities (mirrors
   `RefundShell`'s own Gap #7 "harmless dead end, caught by `PermissionDenied`" reasoning: refund-ui
   has no cheap client-side way to know if THIS caller specifically holds `request:review`).
4. **L:** `SkeletonListRows`. **E:** genuine zero-batches-ever state ("No compilations yet. Compile
   your first monthly batch to get started." + the same "+ Compile new batch" CTA) — distinct from
   PD, a real successful empty result. **Err:** `ErrorBanner` + Retry. **PD:** `PermissionDenied`
   (AC-8.3, no `request:review` at all), no Retry — same defense-in-depth posture as every other
   accounting screen.

---

## Screens & states

Legend (unchanged from 007): **L**oading, **E**mpty, **P**opulated, **Err**or (RFC 7807),
**PD** permission-denied (403, capability entirely absent), **NF** not-found (404), **G**
guardrail (409, a genuinely-blocked terminal race).

### Screen B1 — Batch history (`/refund/batches`, NEW)

- **Purpose:** entry point for every accounting monthly-processing flow (US-8).
- **Key elements:** heading ("Monthly processing" — matches the spec's own feature name, distinct
  from the row-list's own implicit "batch history" framing), "+ Compile new batch" button, a flat
  list of batch rows (cutoff date, `BatchStatusBadge`, request count, per-currency totals,
  email-status indicator) — no pagination (Gap, carried from 007's Gap #6, see below).
- **L:** `SkeletonListRows` (reuse, as-is) + `aria-live="polite"` sr-only "Loading batch history".
- **E:** "No compilations yet. Compile your first monthly batch to get started." + CTA.
- **P:** the row list; each row opens Screen B3.
- **Err:** `ErrorBanner` (reuse, as-is) + Retry.
- **PD:** `PermissionDenied` (reuse, as-is), no Retry (AC-8.3).
- Reads a one-shot `confirmation` search param — NOT used today (F1's post-compile confirmation
  lands on B3, not back on B1, unlike 007's Approve/Reject which return to the LIST) — B1's route
  still carries `validateSearch` for consistency/future-proofing only if a future flow needs it;
  this design does not require it and flags it as unused scaffolding rather than silently adding
  dead code (frontend-dev should skip it on B1 unless a concrete need arises — see Gaps).

### Screen B2 — Compile & preview (`/refund/batches/new`, NEW)

- **Purpose:** pick a cutoff, review exactly what would be compiled, then compile (US-1).
- **Key elements:** cutoff `<input type="datetime-local">` (labelled "Cutoff", pre-filled to now,
  helper text "Defaults to the current moment — requests approved after this point are not
  included"), "Preview" button, overall `BatchSubtotalsPanel`, `BatchEmployeeGroupList` (mode
  `preview`), "Compile this batch" button, "Cancel" link back to B1.
- **L:** `SkeletonListRows` while `GET /batches/candidates` is in flight, with its own sr-only
  "Loading candidates" announcement (distinct wording from B1's own loading announcement, so a
  screen-reader user navigating both screens in one session never hears an ambiguous repeat).
- **E (the compile-empty-set refusal, AC-1.4):** "No approved, unbatched requests are eligible as
  of this cutoff." — "Compile this batch" disabled with the same inline note (not an error state).
- **P:** the populated preview; "Compile this batch" enabled.
- **Err:** `ErrorBanner` + Retry (a genuine `GET /batches/candidates` network/5xx failure — distinct
  from the E state above, which is a successful-but-empty 200).
- **PD:** `PermissionDenied` (AC-1.8), no Retry.
- **Compile confirm (irreversible-adjacent, not fully irreversible — a compiled batch CAN still be
  discarded):** `ConfirmDeleteModal` (`tone="positive"`) as F1 step 6 describes; its own inline
  error slot surfaces a 422 candidate-set-changed race without a full-page interrupt.

### Screen B3 — Batch detail (`/refund/batches/$id`, NEW — also the email deep-link landing page)

- **Purpose:** inspect a batch of any status, download its PDF, manage its email delivery, and —
  only while `compiled` — mark it paid or discard it (US-2/US-3/US-4/US-6/US-8).
- **Key elements (every status):** header (`BatchStatusBadge`, cutoff, generated-at, generating
  user, batch reference/id), overall `BatchSubtotalsPanel`, `BatchEmployeeGroupList` (mode
  `detail`, request rows link to `/refund/review/$id`), "Download PDF" (`BatchPdfLink`), email
  status text + "Resend email" button (always present/enabled, AC-3.3).
- **Additional, `compiled` only:** "Mark as paid" and "Discard batch" buttons.
- **Additional, `paid` only:** "Paid on `<paidAt>` by `<paidByEmail>`" line.
- **Additional, `discarded` only:** "Discarded on `<discardedAt>` by `<discardedByEmail>`" line.
- **L:** `SkeletonListRows`.
- **Err:** `ErrorBanner` + Retry.
- **NF:** neutral "doesn't exist" + back-link to B1 — a genuinely-nonexistent id only (batch reads
  are NOT entity-scoped, plan.md's D1 — there is no "exists but you can't see it" case here, unlike
  007's request-level NF states).
- **PD:** `PermissionDenied` (AC-2.3), no Retry.
- **G (guardrail-blocked):** a 409 on Mark-as-paid or Discard (a concurrent-resolution race, AC-4.3/
  AC-6.2) → `GuardrailDialog`, then a reload reflecting the real current terminal state.
- **Irreversible-action state — Mark-as-paid (F4):** `MarkPaidDialog` (NEW) — batch summary,
  email-status FYI, explicit consequence copy, required acknowledgement checkbox gating Confirm.
- **Irreversible-action state — Discard (F6):** `ConfirmDeleteModal` (`tone="destructive"`, reuse
  as-is) — standard two-button confirm; less severe than Mark-as-paid because discard is
  correctable (the released requests can be recompiled), which is why it does NOT get the extra
  checkbox gate — see Component inventory for that distinction's reasoning.
- **Email send/resend feedback:** `ToastBanner` (reuse, as-is) — tone `success`/`error`, the one
  deliberate exception to this feature's otherwise-`aria-live`-only posture (F3 step 2).
- Reads a one-shot `confirmation` search param (F1 step 6's post-compile redirect) via the SAME
  `validateSearch` technique 007's `/review` list route uses, applied here to a DETAIL route.

### `RequestDetailPage` (`/refund/requests/$id`, EXTENDED — 007's Screen R2)

- Gains a fifth, `paid` render branch (F5), sibling to `draft`/`submitted`/`approved`/`rejected`.
  No other branch changes. `RequestStatusBadge` (extended, see below) renders the new variant.

### `ReviewDetailPage` (`/refund/review/$id`, EXTENDED — 007's Screen A2)

- Gains a `paid` render branch, structured identically to its existing `approved` branch (full
  `readOnlyApproved`-mode line list, `SubtotalsPanel showApproved`) PLUS a "Paid on `<date>` by
  `<email>`" line, MINUS `MonthlyProcessingNote` (suppressed for the same reason `RequestDetailPage`
  suppresses it on `paid` — showing "processed on a monthly cycle" copy for an already-paid
  request would be actively misleading, not merely redundant; this design applies AC-5.3's logic
  symmetrically to the accounting-facing view even though the AC's literal text is scoped to the
  employee side, because leaving the stale note in place is a real UX defect, not a feature). No
  "which batch is this" backlink is added here — no AC asks for one (see Gaps: flagged as a
  plausible, deliberately NOT-built enhancement, not scope creep).
- Previously (007), any status other than `submitted`/`approved`/`rejected` fell through to a
  generic `readOnly` fallback branch — that fallback previously (silently, incidentally) already
  covered `paid` without knowing it. This design REPLACES that silent fallback with an explicit
  `paid` branch carrying the `paidAt`/`paidBy` line the fallback never rendered.

### `RefundShell` (root layout, EXTENDED — 007's root layout)

- Gains a third nav item ("Monthly processing" → `/refund/batches`), rendered unconditionally next
  to "My requests"/"Review queue" — the identical Gap #7 reasoning 007 already documents for
  "Review queue": refund-ui has no cheap, ADR-0007-compliant way to know a caller's exact
  permissions client-side, so this internal tab is a harmless dead end for a non-accounting user,
  caught by Screen B1's own `PermissionDenied` (F8).

---

## Component inventory

| Element | Reuse / NEW | Notes |
|---|---|---|
| `shell/session`, `shell/tokens.css` | **Reuse (as-is, shared)** | Unchanged federated modules |
| `ErrorBanner` | **Reuse (as-is)** | Every new L/Err state |
| `SkeletonListRows` | **Reuse (as-is)** | Every new L state |
| `PermissionDenied` | **Reuse (as-is)** | Every new PD state |
| `GuardrailDialog` | **Reuse (as-is)** | Mark-as-paid/Discard 409 races |
| `ConfirmDeleteModal` | **Reuse (as-is / extended)** | Discard uses it as-is (`tone="destructive"`); Compile-confirm uses it with 007's existing `tone="positive"` extension, called inline exactly as 007's own "Delete request" did — no new wrapper file for either |
| `ToastBanner` | **Reuse (as-is)** | Email send/resend feedback only (F3) |
| `CurrencyBadge` | **Reuse (as-is)** | Inside `BatchSubtotalsPanel` |
| `formatMoney`, `formatDate`, `ownerDisplay` | **Reuse (as-is)** | Unchanged libs |
| `refundApi.ts` (`getJson`/`sendJson`/`ApiError`) | **Reuse (as-is)** | `batchesApi.ts` builds on this exactly as `requestsApi.ts`/`reviewApi.ts` already do |
| `RequestStatusBadge` | **Reuse (extended)** | +`paid` variant (glyph `◆`, `var(--grn)`) — see below |
| `RefundShell` | **Reuse (extended)** | +"Monthly processing" nav link (Gap #7 reasoning carried forward) |
| `RequestDetailPage` | **Reuse (extended)** | +`paid` render branch (F5) |
| `ReviewDetailPage` | **Reuse (extended)** | +`paid` render branch, replacing the previous silent generic fallback |
| `router.tsx` | **Reuse (extended)** | +3 routes (`/batches`, `/batches/new`, `/batches/$id`), same flat-sibling factory shape as 007's own routes |
| `BatchStatusBadge` | **NEW, small** | 3 variants (`compiled`/`paid`/`discarded`) — no existing badge models a 3-value batch-lifecycle state; mirrors `RequestStatusBadge`'s glyph+text+color convention in its own file, matching that component's own precedent of one file per badge "kind" (`EntityBadge`/`CurrencyBadge` are already split the same way) |
| `BatchSubtotalsPanel` | **NEW, small** | `SubtotalsPanel` is NOT reusable as-is: its `Subtotal` type mandates `requestedCents`, but every batch/candidate subtotal on the wire is `{currency, approvedCents}` only (plan.md's `CandidatePreview`/`BatchSummary`/`BatchDetail` shapes) — a batch's requests are already `approved`, "requested" isn't a meaningful second figure here. A lighter one-figure-per-currency card, reusing `CurrencyBadge`+`formatMoney` |
| `formatBatchSubtotalsPreview` (lib) | **NEW** | Condensed single-line join for Screen B1's rows, mirroring `formatSubtotalsPreview`'s shape but over the one-figure `{currency, approvedCents}` batch subtotal, not the two-figure `Subtotal` |
| `BatchEmployeeGroupList` | **NEW** | Mode-driven (`preview`\|`detail`), the same `mode` prop convention `ExpenseLineRow`/`AttachmentList` already establish: `preview` (Screen B2, from `CandidatePreview` — counts + subtotals, no request links, nothing persisted yet to link to) vs `detail` (Screen B3, from `BatchDetail` — real request rows linking to `/refund/review/$id`). One component, not two, to keep the "per-employee-then-per-currency" presentation identical between rehearsal and reality |
| `BatchPdfLink` | **NEW, small** | Click → mint (`GET /batches/:id/pdf-url`) → open — the exact `AttachmentDownloadLink` contract, re-minting on every click rather than trusting the initial response's `pdf.url` (which is only ~60s fresh) |
| `MarkPaidDialog` | **NEW** | Cannot be a `ConfirmDeleteModal` extension for the same structural reason 007's `RejectDialog` couldn't be: the tab sequence has THREE stops (checkbox, Cancel, Confirm), not two — `ConfirmDeleteModal`'s trap is hardcoded to exactly two buttons. Ports `RejectDialog`'s disabled-until-valid technique (there: a required textarea; here: a required acknowledgement checkbox) plus batch-summary + email-status-FYI body content unique to this action's stakes (money-moving, N requests, no undo — see Accessibility and Gaps for why this goes beyond `ApproveDialog`'s bar) |
| `BatchStatusBadge`'s `paid` glyph (◆) reused on `RequestStatusBadge` | **Design choice** | Both badge families use the SAME glyph for their respective terminal-settled states (a batch reaching `paid`; a request reaching `paid`), reinforcing visually that they're the same real-world event seen from two angles — deliberately distinct from `RequestStatusBadge`'s existing `approved` (✓), so a request row list mixing `approved`/`paid` rows stays scannable |
| Screen B1 row | **NEW, small** | Ported convention from Screen R1/A1's row shape (007) |
| `BatchHistoryPage`, `CompileBatchPage`, `BatchDetailPage` | **NEW** | The three new screens (B1/B2/B3) |
| `batchesApi.ts` (lib) | **NEW** | Typed `refund-api` batch operations — `listCandidates`, `list`, `get`, `compile`, `getPdfUrl`, `sendEmail`, `markPaid`, `discard` — built on `refundApi.ts`'s `getJson`/`sendJson`, mirroring `requestsApi.ts`/`reviewApi.ts`'s own construction |
| `Pagination` | **Not applicable** | `GET /batches` is a bare array in plan.md's contract, carrying forward 007's Gap #6 |

**Ratio:** ~17 reused-or-extended (12 as-is: `shell/session`, `shell/tokens.css`, `ErrorBanner`,
`SkeletonListRows`, `PermissionDenied`, `GuardrailDialog`, `ConfirmDeleteModal`, `ToastBanner`,
`CurrencyBadge`, `formatMoney`, `formatDate`, `ownerDisplay`/`refundApi.ts` plumbing; 5 extended:
`RequestStatusBadge`, `RefundShell`, `RequestDetailPage`, `ReviewDetailPage`, `router.tsx`) : **~11
NEW** (`BatchStatusBadge`, `BatchSubtotalsPanel`, `formatBatchSubtotalsPreview`,
`BatchEmployeeGroupList`, `BatchPdfLink`, `MarkPaidDialog`, the B1 row shape, `BatchHistoryPage`,
`CompileBatchPage`, `BatchDetailPage`, `batchesApi.ts`).

This is a markedly more reuse-heavy ratio than 007's own ~5:16 (refund-ui's first screen set,
built from nothing) or `specs/004`'s ~9:20 — expected, because 008 extends an app that ALREADY has
every foundational pattern this feature needs (status badges, subtotal cards, confirm dialogs,
guardrail races, list/detail screens, the `mode`-prop convention) conventioned by 007. The NEW
components here are almost entirely batch-domain-specific (a genuinely new noun — "batch" — with
no prior analog), not infrastructure this feature has to invent from scratch.

---

## Accessibility

- **Mark-as-paid confirm (the irreversible, money-moving action — the feature's top hotspot):**
  `MarkPaidDialog` follows `RejectDialog`'s exact keyboard contract, generalized from
  [textarea, Cancel, Confirm] to [checkbox, Cancel, Confirm]: `role="alertdialog"`, `aria-modal`,
  `aria-labelledby`/`aria-describedby` covering the consequence copy AND the batch-summary/
  email-status content, a full Tab focus trap across exactly the three interactive elements
  (Confirm excluded from the trap while `disabled`, the same `.filter(!el.disabled)` technique
  `ConfirmDeleteModal`/`RejectDialog` already use), Escape = Cancel. Default focus on **Cancel**
  (not the checkbox) — unlike `RejectDialog`'s "focus starts on the textarea because typing there
  is the very next required action," a checkbox's very next action (Space) is exactly what an
  accidental stray keypress right after the dialog opens could trigger; defaulting to the safe,
  inert Cancel button avoids that, matching `ConfirmDeleteModal`'s own "safe default" philosophy
  for a consequential action. The Confirm button stays **disabled until the checkbox is checked**
  (client-side; a same-shaped server-side rejection is not expected for this specific gate since
  it's purely a UI safeguard, not a validated field — unlike `RejectDialog`'s motivation, which the
  server also validates at 422). The checkbox's label is the full acknowledgement sentence (not a
  terse "Confirm"), so a screen-reader user tabbing to it hears the complete commitment they're
  making, not just a fragment.
- **Discard confirm:** plain `ConfirmDeleteModal`, unchanged two-stop trap (checkbox/Cancel/Confirm
  is deliberately NOT applied here — see Component inventory: discard is correctable via
  recompiling the released requests, so it doesn't carry Mark-as-paid's "genuinely no way back"
  weight, and gating it identically would train users to click through acknowledgement checkboxes
  reflexively, diluting the signal on the one dialog where it matters).
- **`aria-live` outcomes:**
  - Compile → the one-shot `confirmation` search param lands on Screen B3 and announces via the
    SAME sr-only `aria-live="polite"` paragraph + read-and-strip-once pattern 007's
    `ReviewQueuePage` already uses for Approve/Reject, applied to a detail route.
  - Mark-as-paid / Discard → an inline `aria-live="polite"` confirmation on Screen B3 itself (no
    navigation happens), with focus moved to the status heading immediately after — the identical
    `justTransitioned` + `tabIndex={-1}` + `ref.current?.focus()` technique `RequestDetailPage`/
    `ReviewDetailPage` already use for submit/withdraw/approve/reject.
  - Email resend → `ToastBanner`, `role="status"`/`aria-live="polite"` on success (auto-dismisses),
    `role="alert"` on failure (persistent until dismissed) — `ToastBanner`'s existing two-tone
    contract, unchanged.
- **Download-PDF action semantics:** `BatchPdfLink` is a `<button>`, not a static `<a href>` — the
  URL must be freshly minted on every click (a ~60s-lived presigned GET), so a plain anchor with a
  stale `href` would be actively wrong after the link goes cold. Its accessible name is explicit
  ("Download compiled PDF for batch `<reference>`"), and a minting failure surfaces inline next to
  the button (`role="alert"`) rather than silently doing nothing — mirroring
  `AttachmentDownloadLink`'s existing `idle`/`minting`/`error` states verbatim.
  Keyboard/focus is otherwise unremarkable (a native button; opening a new tab is the browser's own
  behavior, not something this component manages).
- **Cutoff input:** a native `<input type="datetime-local">` with an explicit `<label htmlFor>`
  (no placeholder-as-label, matching every other form field in this suite) and helper text
  explaining the "defaults to now, requests approved after this point are excluded" semantics —
  read by assistive tech via `aria-describedby`, not only visually adjacent text.
- **`BatchEmployeeGroupList` (both modes):** each employee group is a labelled region
  (`aria-label` naming the employee, mirroring 007's own "disambiguate a list of otherwise-identical
  controls/sections" convention already applied to Screen A2's per-line approved-total inputs); in
  `detail` mode, each request row's link carries a full `aria-label` ("Open `<employee>`'s request,
  `<status>`, `<amount>`") rather than relying on visually-adjacent badge/amount text alone, the
  same pattern 007's Screen R1/A1 rows already use.
- **Keyboard operation:** every interactive element is a native `<button>/<input>/<a>` — this
  suite's stated posture (`UserDetail.tsx`'s own doc comment, carried into every 007 component);
  no custom grid/roving-tabindex nav is introduced (no AC here asks for one, same restraint 007's
  own design.md states for `ExpenseLineRow`).
- **Color/contrast:** `BatchStatusBadge` follows the same glyph+text+color rule as every other
  badge in this suite (`RequestStatusBadge`/`EntityBadge`/`CurrencyBadge`) — color is never the
  only signal.
- **Money formatting:** `BatchSubtotalsPanel` reuses `formatMoney` unchanged — two decimals, comma
  separator, explicit currency label, never a bare number.
- **English-only copy via `strings.ts`:** every new string (Screens B1/B2/B3, `MarkPaidDialog`,
  `BatchStatusBadge`, the `paid` additions to `RequestDetailPage`/`ReviewDetailPage`) extends
  `strings.ts`'s existing namespaced structure — no hardcoded JSX text anywhere, and — per this
  spec's own explicit Non-goal ("Bilingual (Italian) email or PDF content for this feature… this
  feature does not reopen or resolve that gap") — no Italian, consistent with 007's own unresolved
  i18n gap (007 design.md Gap #1, still open, not this feature's to fix).

---

## Gaps, scope notes & drift (report to PO/architect — not designed around)

1. **Plan.md's own citation of the pre-compile candidate preview as "(US-2)"** (its `refund-ui
   screen architecture` section) doesn't match spec.md's actual US-2 ACs (2.1–2.3), which are
   textually about inspecting an ALREADY-COMPILED batch, not a pre-compile dry run. This design
   builds the preview regardless (`GET /batches/candidates` is unambiguously specified in plan.md's
   API contract table, and AC-1.4's refusal-on-empty effectively requires the client to know the
   candidate set before attempting compile) — flagging the citation mismatch for the record, not
   proposing a spec/plan change.
2. **The "frozen cutoff" WYSIWYG choice (F1 step 2)** — that the cutoff value used for `POST
   /batches` is whatever produced the on-screen preview, not silently re-resolved to "now" again at
   compile-click time — is this design's judgment call, not something plan.md or spec.md states
   either way. The alternative (always compile against the literal current instant, ignoring
   whatever was last previewed) is equally defensible and would pick up any newly-approved requests
   between preview and click. Flagging for PO/QE to confirm the chosen "what you previewed is what
   you get" behavior matches how accounting expects this to work.
3. **`MarkPaidDialog`'s required acknowledgement checkbox** is a designer judgment call responding
   to the task brief's own "disabled-until-confirmed if warranted" prompt and the spec's repeated
   emphasis on Mark-as-paid's irreversibility (AC-4.3's "no undo, un-mark, or reopen path
   anywhere") — no AC literally mandates a checkbox gate beyond the ordinary confirm dialog every
   other decision (Approve/Reject/Discard) already gets. Flagging for PO/QE to confirm the extra
   friction is warranted here and not, e.g., expected to match Approve's single-click-through bar.
4. **Screen B1's `validateSearch` for a one-shot `confirmation` param is currently unused** — F1's
   post-compile confirmation lands on Screen B3 (the new batch's own detail), not back on B1 (unlike
   007's Approve/Reject, which DO return to their list). This design still notes B1 could carry the
   same scaffolding for consistency/future-proofing but does not require it — flagging so
   frontend-dev doesn't feel obligated to wire dead code, and doesn't accidentally build a "return
   to B1 after compile" flow this design does NOT specify (B3 is the intended landing screen).
5. **Whether the employee-facing `GET /requests/:id` response omits `batchId`/batch-reference
   fields entirely, or merely includes them without refund-ui rendering them,** is not settled by
   plan.md's shared `RefundRequestDetail` shape (which plan.md doesn't show extended with a
   `batchId` field explicitly, but doesn't rule one out either). AC-5.3 bans batch composition from
   ever being SHOWN to the employee, which this design honors by simply never rendering such a
   field — but if the wire contract does carry it, that's a latent over-exposure this design's
   client-side omission doesn't actually close (defense-in-depth would be the server never sending
   it on the employee-facing route at all). Flagging for backend-dev/architect to confirm.
6. **No "which batch was this request paid in" backlink is designed on `ReviewDetailPage`'s new
   `paid` branch**, even though it would be a natural, low-effort addition (accounting can already
   reach the batch from Screen B1/B3's own request rows, just not the reverse direction). No AC asks
   for it — flagging as a plausible, deliberately-not-built follow-up, not scope creep either
   direction (mirrors 007's own Gap #3 treatment of the "duplicate rejected request" convenience).
7. **`ReviewDetailPage`'s previous generic `readOnly` fallback branch (any status other than
   `submitted`/`approved`/`rejected`) silently already covered `paid`** before this feature existed,
   incidentally, without a `paidAt`/`paidBy` line. This design explicitly carves out a proper `paid`
   branch to replace that silent coverage — flagging only so a future reviewer doesn't read the
   fallback's prior silent handling as evidence that a dedicated branch was optional; it is now the
   documented, intended behavior.
