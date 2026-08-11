---
spec: 014
evaluated: 2026-08-11
rubric: default-v2
score: 85
verdict: PASS
---
# Eval report: Motivo autocomplete from the employee's own past mileage lines

**Rubric source.** `gates/configs/eval-rubric.yml` does **not** exist in this repo. The
central rubric was located in the WellForge installation itself —
`/opt/homebrew/Library/Taps/matteocodogno/homebrew-wellforge/gates/configs/eval-rubric.yml`
(byte-identical to `/Users/matteocodogno/LAB/aiscream/wellforge/gates/configs/eval-rubric.yml`),
version `default-v2`. No `specs/014-motivo-autocomplete/eval.md` override file exists, so the
central rubric applies unmodified. `design.md` is present, so the conditional
`design_fidelity` dimension **applies** and the weight pool is 115, normalised ×100/115.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | 32/32 ACs mapped to named tests; 111 refund-api + 610 refund-ui tests green in my own run. Sampled + mutation-verified: AC-5.3/5.4 (`ExpenseLineComposer.test.tsx:pressEnterOnMotivo`), AC-1.4 (`tripSuggestions.test.ts` substring suite), AC-2.5 (`suggestions.service.test.ts:117-171`), AC-2.4 (`suggestions.service.test.ts:282-317` + `suggestions.routes.test.ts:603-633`), AC-4.1/4.2/4.3 (`suggestions.routes.test.ts:302-445`), AC-4.4 (`suggestions.routes.test.ts:663-757`), AC-5.7 (`noHardcodedStrings.test.ts`) |
| Spec fidelity / no drift | 20 | 4 | 3 | 16.0 | Plan D1–D9 realised verbatim; drift amended in-artifact (`89015d2` plan D3 + module path; AC-5.7 amendment recorded at `spec.md:296-303`). Deduction: the 200-signature cap (`suggestions.service.ts:42`) is a self-declared "bounded deviation from AC-1.4's *any matching trip*" documented in plan R1 + ADR-0041, but `spec.md` AC-1.4 was never amended to carry it — unlike AC-5.7, which was |
| Test quality | 20 | 4 | 3 | 16.0 | 4 independent mutations all killed (see Findings). Deduction: 24 hardcoded calendar dates remain in `suggestions.routes.test.ts` (earliest `2025-01-01:494`), first detonation **2027-01-02**; and the R2 vector mirroring has no mechanical cross-app check |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | House idioms matched exactly: `throw new Error("Unexpected database failure …")` identical to `rates/effective.routes.ts:104` / `requests.routes.ts:162`; Effect+`DatabaseError` repo per `requests.repo.ts`; `defaultHook`→400 per `rates/effective.routes.ts`; inline-style + CSS-custom-property idiom; no new deps; `apiFetch` init-forwarding claim verified true at `shell/src/lib/session.ts:269-278`. Nits: comment density 37–56% vs house 12–21%; one over-claiming docblock; `lastUsedOn: z.string()` unformatted |
| Design fidelity (UI) | 15 | 5 | 3 | 15.0 | `design.md` covers 12 states incl. every loading/empty/error state (S3/S6/S7), a literal ARIA/keyboard contract, live-region rule, focus + scroll-into-view, measured contrast (4.97:1/4.88:1), and a full component-inventory reuse mapping (4 reused / 2 extended / 1 untouched / 1 NEW, justified against `admin-ui/Combobox.tsx`). Every item verified realised in `MotivoSuggestField.tsx` |
| Trajectory | 10 | 2 | 2 | 4.0 | **No `.forge/runs/*014*` run trace exists** (traces exist for 001–013). Rubric-mandated neutral floor. Git history is consistent with a correct sequence (`a7c9bb2` T1 → … → `eb2c126` T15 → `6338f88` T16, plus QE follow-up `73f19d2`) but the rubric scores 2 when no trace exists |
| **Total** | **115** | | | **98.0 → 85.2/100** | normalised over the 115-weight applicable pool |

**Verdict: PASS** — 85.2 ≥ pass_score 80, and every applicable dimension is at or above its
floor (ac 5≥4, spec 4≥3, test 4≥3, code 4≥3, design 5≥3, trajectory 2≥2). No dimension is
sub-floor.

## What I verified myself (not inherited from QE/OWASP)

Both prior verdicts were treated as claims, not evidence. Independent checks:

- **Ran the suites.** `refund-ui`: 52 files / 610 tests green, `pnpm lint` clean, `pnpm build`
  clean. `refund-api`: `bun run typecheck` clean; the 4 feature test files = 111 pass / 0 fail /
  988 assertions. The 3 `jwtMiddleware` failures in the full run are confirmed **pre-existing**:
  they reproduce with every specs/014 file excluded (`bun test src/settings src/rates src/auth
  src/review src/lib src/authz src/attachments src/batches` → 300 pass / 3 fail) and do **not**
  reproduce when `jwt.middleware.test.ts` runs alongside `suggestions.routes.test.ts` (41 pass /
  0 fail). Not this feature's defect.
- **Four mutations, in a throwaway git worktree (the working tree was never modified;
  `git status` verified clean afterwards). All four were killed:**
  1. Removed `event.preventDefault()` from the Enter-on-highlight branch → 2 failures, including
     `ExpenseLineComposer > AC-5.3: Enter on a HIGHLIGHTED option picks it and the form is NOT
     submitted`. The Enter trap is genuinely pinned, and `pressEnterOnMotivo` reproduces implicit
     form submission faithfully (raw `dispatchEvent` inside one `act()`), which a naive
     `fireEvent.keyDown` would not.
  2. Swapped the UI fold's `[̀-ͯ]` for `\p{Diacritic}` → 3 vector failures (dakuten,
     middle dot, spacing acute). The fold header's empirical claims are test-pinned, not prose.
  3. Inlined `aria-label="Past trips"` into `MotivoSuggestField.tsx` → `noHardcodedStrings.test.ts`
     failed with the exact offender listed. AC-5.7's guard really enforces.
  4. Reordered `winsDisplay`'s election keys (count before recency) → 3 AC-2.5 failures. The
     display-text rule is pinned to "most recent", not "most popular".
  5. (bonus) `SUGGESTION_WINDOW_MONTHS` 24→26 → 3 cutoff failures; `includes`→`startsWith` →
     5 AC-1.4 failures plus 7 component failures.
- **Checked R2 mechanically.** Extracted both 28-vector tables and compared `input`/`expected`
  pairs programmatically: **28 vs 28, identical, in order** — the mirrored contract holds today.

## Findings

### spec_fidelity (4/5) — the R1 cap never reached the spec
`spec.md` AC-1.4 still reads unqualified ("a past trip matches if the typed text occurs
**anywhere** within its normalised motivo"). The shipped behaviour bounds this at 200 trip
signatures (`suggestions.service.ts:42`) plus a 2000-triple `take` (`suggestions.repo.ts:41`).
The deviation is disclosed honestly and in three places a maintainer will find it — plan R1
(`plan.md:559`), the constant's own docblock, and ADR-0041 twice ("a real, bounded deviation
from AC-1.4's *any matching trip*", lines 142-144 and 262-266) — and it was accepted at the
approved plan gate. It is **not** disclosed anywhere a user would find it, and the spec was not
amended, even though the very same feature *did* amend `spec.md` for the AC-5.7 i18n drift. The
inconsistency in how two accepted deviations were handled is the whole of this deduction.
A second, subtler point the ADR does not state: the repo's `take: 2000` is ordered by
*exact-triple* count, so for a pathological corpus a fold-merged group's `count` could be
understated — the truncation argument in `suggestions.repo.ts:96-99` reasons about triples, not
fold groups. Immaterial at real corpus sizes.

*Owner if pursued: product-owner (amend AC-1.4 to carry the bound) — not a code change.*

### test_quality (4/5) — a known, unfixed time bomb
`suggestions.routes.test.ts` still carries 24 hardcoded calendar dates. The earliest,
`"2025-01-01"` (lines 494-496, the AC-2.5 grouping test), leaves the 24-month window on
**2027-01-02**, at which point `plainTrip.count` becomes 2 instead of 3 and CI reddens with no
code change. The default seed date `"2026-06-01"` (line 181) takes most of the rest of the file
with it on 2028-06-02. This is disclosed and was partially remediated — `73f19d2` converted the
AC-2.3 and AC-2.4 tests to the relative `monthsAgo()` helper and documented exactly this hazard
in a comment (lines 536-541) — but the remaining 22 were left. A test file that documents the
failure mode and then keeps 22 instances of it is a deliberate carry-forward, not an oversight;
weighed as one real defect, not as a coverage gap. Everything else in the suite is
exceptional: the AC-4.4 console test asserts the logger *did* run so it cannot pass vacuously
(line 755); the scroll-into-view suite stubs `Element.prototype` and then asserts its own
non-leakage (lines 985-988); the e2e asserts `suggestionCalls[0]).not.toContain('lug')`, proving
D1/AC-4.4 on the wire rather than by argument.

*Owner: dev (mechanical — replace the remaining literals with `monthsAgo()`).*

### code_quality (4/5) — nits only
- Comment density measured at 56% (`suggestions.repo.ts`), 47% (`suggestions.service.ts`), 37%
  (`normaliseMotivo.ts`, `suggestions.routes.ts`) against a house norm of 12–21%
  (`lines.routes.ts` 12%, `rates/repo.ts` 16%, `requests.repo.ts` 21%). The content is accurate
  and load-bearing (Unicode reasoning, the routing-swallow trap, the owner-scope invariant), but
  2–4× the surrounding norm reads as foreign at a glance.
- `refundApi.ts`'s new docblock over-claims: "an `init.headers.Authorization` … is discarded
  rather than honoured". `apiFetch` only overrides it when a JWT resolved (`session.ts:269-272`);
  with `ensureJwt()` returning null an injected header would survive. Not reachable from this
  feature (it passes only `{ signal }`), but the comment states an absolute that is conditional.
- `lastUsedOn: z.string()` (`suggestions.schemas.ts:80`) does not enforce the documented
  `YYYY-MM-DD` shape, so the published OpenAPI is looser than the plan's contract. The route
  test asserts the format; the schema does not.

### trajectory (2/5) — missing artifact, not missing rigour
There is no `.forge/runs/*-014-motivo-autocomplete.json`, although the repo carries traces for
every prior feature (001–013). Per the rubric's own note, absent a trace the score is the neutral
2 — this is an **observability gap, not evidence of a bad trajectory**, and it alone costs 5.2
normalised points. Git history is fully consistent with a correct sequence: one commit per task
in the exact dependency order of `tasks.md`'s graph (T1 `a7c9bb2` → T2/T3/T4 → T5 → T6 → T7 →
T8/T9 → T10 → T11/T12 `d0181cc` → T13 → T14 → T15 `eb2c126` → T16), a QE remediation commit
(`73f19d2`), and two honest checkbox-reconciliation commits (`c5d7f6e`, `51f5b5d`).

### Honest bookkeeping (no finding)
T17 is correctly left **unchecked** and `spec.md` correctly reads `status: in-progress` — T17 is
the gate task that depends on this eval. No task is marked done that isn't: I spot-checked T7
(`getJson` additive, every existing call site untouched), T12 (`git diff` on
`ExpenseLineRow.tsx` is empty — AC-1.8 satisfied structurally), T14 (guard verified by mutation)
and T16 (changeset names both `@operai/refund-api` and `@operai/refund-ui`, minor each). ADR
index in `CLAUDE.md` updated to 0042.

## Blocking the done gate

Nothing in this eval blocks it. Two mechanical items T17 must confront:

1. **T17's literal criterion `cd refund-api && bun run typecheck && bun test` cannot go green**
   — the 3 pre-existing `jwtMiddleware` failures from the cross-file `mock.module("jose")`
   collision are unrelated to specs/014 but will fail that command. T17 needs either the
   collision fixed (separate work) or its done-when amended to name the known-failing baseline.
2. **The shell e2e was not independently executed by me** (`shell/e2e/motivo-autocomplete.spec.ts`
   needs the full stack + direnv + 1Password). I reviewed its source and rate it high quality —
   real API seeding, keyboard-only navigation, absence-assertions, relative dates — and the QE
   verdict reports 2 passed. Re-running it is part of T17 regardless.

## Strongest single criticism (does not block)

**The R2 mitigation is asserted far more strongly than it is enforced.** Both fold modules carry
a box comment saying "MIRRORED RULE — DO NOT CHANGE ONE SIDE ALONE" and the plan calls the
shared vector table "the R2 mitigation"; `plan.md:231` even requires the UI suite to "assert
**that module's exported** `MOTIVO_FOLD_VECTORS` table verbatim". What shipped is a hand-copied
28-vector literal inside `refund-ui/src/lib/tripSuggestions.test.ts:40`, with **no mechanical
link of any kind** between the two apps. The consequence is precisely R2's named failure mode:
a *coherent* one-sided change — editing `refund-api`'s fold **and** its vectors together, which
is exactly what a well-behaved author would do — leaves both suites green while the two folds
silently diverge, and the symptom in production is suggestions quietly not appearing for one
class of query, with no error anywhere. I confirmed the tables are identical **today**, so this
is latent, not live; and it is consistent with the ADR-0025 precedent (`refund-ui`'s
`computeMileageAmountCents.test.ts` hand-writes its vectors too), and ADR-0041 discloses it
("kept in step only by mirrored canonical test vectors … bounds but does not eliminate the
divergence risk"). What makes it the strongest criticism anyway is that a cheap enforcement was
demonstrably within reach and within this very feature's idiom: `noHardcodedStrings.test.ts`
already does a cross-file `readFileSync` of source text, and I wrote a 30-line script during
this eval that reads `refund-api/src/requests/normaliseMotivo.ts` from `refund-ui` and asserts
the two tables byte-identical. That single test would have converted a comment-enforced contract
into a machine-enforced one, and would also have deleted the "neither side may be edited alone"
process obligation the two headers currently rely on.

## Recommended next step

**PASS** — spec 014 may proceed to the done gate. Before `/wellforge:done`:

- Run `cd shell && pnpm e2e motivo-autocomplete.spec.ts` with the stack up (T17).
- Decide T17's treatment of the 3 pre-existing `jwtMiddleware` failures (amend the done-when or
  fix the mock collision as separate work).
- Optional, non-blocking, in priority order: (a) replace the remaining 22 hardcoded dates in
  `suggestions.routes.test.ts` with `monthsAgo()` before 2027-01-02 — dev; (b) add the
  cross-app vector-equality test described above — dev; (c) amend `spec.md` AC-1.4 to carry the
  200-signature bound already accepted in plan R1 / ADR-0041 — product-owner.
