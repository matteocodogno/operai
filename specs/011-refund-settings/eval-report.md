---
spec: 011
evaluated: 2026-07-22
rubric: default-v2 (reconstructed from specs/005–010 eval-reports; no central gates/configs/eval-rubric.yml present)
score: 96
verdict: PASS
---
# Eval report: Refund settings — admin-managed accounting distribution email

Rubric note: `gates/configs/eval-rubric.yml` does not exist in the repo (nor a `gates/`
directory — `gates/configs/` is empty). Dimensions/weights/floors/pass_score were
reconstructed from the `specs/005–010` eval-reports (all `default-v2`), consistent with how
008/009/010's own evals were produced. default-v2 = AC(35, floor 4) · Spec(20, floor 3) ·
Test(20, floor 3) · Code(15, floor 3) · Design-UI(15, floor 3, conditional on `design.md`) ·
Trajectory(10, floor 2); pass_score 80. No `specs/011-refund-settings/eval.md` override exists.
**No `design.md` present** → `design_fidelity` is N/A and excluded; the remaining weights sum
to 100 (plain sum, no re-normalisation needed).

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | All 19 ACs mapped in plan.md's total AC→test table + tasks.md coverage map, each to ≥1 executed passing test AND observable behaviour. **Re-run this session (Postgres + MinIO up):** settings 21/0 (`routes.test.ts`, `db.refund-setting-immutability.test.ts`, `env.test.ts`, `scripts/seed-setting.test.ts`); batches 35/0 (`batches.routes.test.ts` incl. AC-2.1–2.4); admin-ui 32/0 (`MileageRatesPage` 18, `settingsApi` 14); refund-ui 18/0 (`BatchDetailPage`); auth refund catalog 15/0 + `seedSettingsAdminGrants` 3/0. Load-bearing ACs verified in code+test: live send-time resolution (`email.ts:55-58`, AC-1.5/2.3/2.4); blocked-send 422+`code` (`batches.routes.ts` `accountingEmailUnconfiguredProblem` + resend guard, AC-2.2); compile decoupled from setting (`batches.routes.ts:341` `compileBatch(cutoff,scope,sub,email)` — recipient param dropped, AC-2.1); actor from JWT never body (`settings/routes.ts:214-215,253-259`, AC-5.1); 403-before-registry-lookup on both read+write (`routes.ts:146,220` vs `:153,227`, AC-3.1); env var removed, boot without it (`env.ts` — `env.test.ts` AC-4.1); no-op suppression incl. null→null (`routes.ts:249`, AC-5.4); DB-level append-only trigger fires under raw UPDATE/DELETE (AC-5.2). |
| Spec fidelity | 20 | 5 | 3 | 20.0 | Realises plan.md D1–D7 and ADR-0027/0028/0029 exactly, zero product scope creep (see below). Every Non-goal respected. |
| Test quality | 20 | 5 | 3 | 20.0 | Adversarial, defeats vacuous passes: stale snapshot explicitly seeded and asserted NOT reused; AC-2.3 mutates the setting twice and asserts the second value; immutability under raw SQL; both no-op branches; seed idempotency incl. real-admin-PUT provenance (see below). |
| Code quality | 15 | 5 | 3 | 15.0 | Idiomatic refund-api clone of the rates module split; authz gate before registry lookup (no key-existence leak); single live-read seam; verbatim immutability trigger (see below). |
| Trajectory | 10 | 3 | 2 | 6.0 | No `.forge/runs/*.json` trace for 011 (confirmed NONE; 0 `011` hits in `.events.jsonl`) → not scored 4–5 on trace evidence; git history strongly corroborates a clean, correctly-ordered, gate-fenced run (see below). |
| design_fidelity | — | N/A | — | — | No `design.md` present — conditional dimension excluded; weights sum to 100 without it. |
| **Total** | | | | **96.0/100** | |

**Verdict: PASS** — 96.0 ≥ pass_score 80, and every applicable dimension ≥ its floor
(AC 5≥4; spec/test/code 5≥3; trajectory 3≥2). No sub-floor dimension, no unmet AC.

## Findings

### AC satisfaction — 5/5
Every AC is met with a passing test and observable behaviour, independently re-verified this
session (DB up). The three ACs a frozen-snapshot design could NOT satisfy are each proven by a
live-value assertion, not just a happy path:
- **AC-2.3** (`batches.routes.test.ts:1185`) seeds `first@…`, changes to `live@welld.ch`, then
  asserts `notifyBatchCompiledCalls[0]?.recipientEmail === "live@welld.ch"` — proving the value
  is resolved live, not cached/frozen.
- **AC-2.4** (`:1205`) compiles while unconfigured (`email.status === "blocked_unconfigured"`),
  then configures `newly-configured@welld.ch`, resends, and asserts the send targets the new
  address — a previously-blocked batch is not permanently blocked.
- **AC-1.5** (`settings/routes.test.ts:311`) PUT then immediate GET round-trips with no restart.
- **AC-2.1** (compile never fails when unconfigured) and **AC-2.5** (mark-paid on a
  `blocked_unconfigured` batch) both covered; **AC-4.1** boot-without-the-env-var proven in
  `env.test.ts` (the `env.ts` schema no longer declares the var — only a comment explaining its
  removal remains). The `prisma:error … refund_setting rows are append-only` lines in the
  immutability suite ARE the AC-5.2 assertion firing, not a defect.

### Spec fidelity — 5/5
Implementation realises every plan.md decision and all three ADRs with no drift:
- **D1** append-only key/value `refund_setting`, current value derived-on-read as latest-per-key
  (`repo.ts:48-60`, `service.ts:31-53`); a new setting is a new registry entry, never a migration
  (ADR-0027).
- **D2** a NEW `settings` resource on the refund catalog, `read`/`manage`, unconditioned, *distinct*
  from `rate` (`catalogs/refund.ts`; `seedSettingsAdminGrants` grants both to `admin`+`refund-admin`,
  never reusing `rate:manage`) — ADR-0028.
- **D3** the `refund_setting` table IS its own audit trail via the identical DB-level
  `BEFORE UPDATE/DELETE` raising trigger copied verbatim from `mileage_rate` (migration SQL);
  no `RefundAuditEntry`/`AuditAction` change (settings are not request-scoped) — ADR-0024 lineage.
- **D5** resend-while-unconfigured → `422` + stable `code:"accounting_distribution_email_unconfigured"`
  + persisted `emailStatus:"blocked_unconfigured"`, distinct from a notify outage's best-effort
  `200`/`failed` (`batches.routes.ts`).
- **D6** live resolution at every send/resend supersedes ADR-0021's `recipientEmailSnapshot` freeze;
  the column is repurposed to nullable per-attempt provenance via a non-destructive
  `DROP NOT NULL` (migration), and `compileBatch` loses its recipient parameter entirely — ADR-0029.
- **D7** cutover is an idempotent operator-run `seed-setting.ts` (not a startup env read, not a
  migration carrying the value); documented in `infra/README.md` (7 references). The RUNNING service
  never reads `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` (AC-4.1 honoured to the letter).
Every Non-goal respected: exactly one address, suite-wide (no per-entity/user config), only this one
env var moved, no new multi-setting UI (one panel), notify-api delivery/ADR-0011/0021 template path
byte-for-byte unchanged (only the `to` source changes).

### Test quality — 5/5
Genuinely verifies behaviour, not shape:
- **Live-resolution is proven negatively**, the strongest possible form: a test seeds a *stale*
  `recipientEmailSnapshot: "stale-prior-attempt@welld.ch"` on the batch row and asserts the resend
  does NOT reuse it, resolving the current setting instead (`batches.routes.test.ts:1288-1291`).
- **DB immutability** asserted under direct raw `UPDATE`/`DELETE` (trigger raises — the assertion,
  not a log artifact), mirroring the `mileage_rate` immutability test.
- **AC-5.4** covers BOTH no-op branches: identical-value and clear-an-already-unconfigured
  (`null → null`) — each asserts no new row, no audit, still 200.
- **AC-5.1** asserts the appended actor comes from the JWT and never the request body.
- **AC-1.3** asserts 422 with *nothing persisted*; **AC-3.1** negative 403 controls on both read and
  write; unknown-key → 404 on both routes.
- **Seed idempotency** (`seed-setting.test.ts`) includes a subtle case: a pre-existing row from a
  *real admin PUT* also short-circuits the seed, so cutover can't clobber an admin-set value.

### Code quality — 5/5
Idiomatic and subtle-correct. The `settings` module is a clean clone of the established
`rates` module split (repo/service/routes/schemas + a descriptor `registry.ts` as the single
extensibility seam): Effect-TS, RFC-7807 Problem JSON, Prisma-only access, `@hono/zod-openapi`,
reused `jwtMiddleware`/`authzMiddleware`/`hasCapability` (no new authz mechanism), `bodyLimit`
before the handler, and the immutability trigger copied verbatim from `refund_audit_entry`/
`mileage_rate`. Genuinely correct details: the capability check runs **before** the registry
lookup on both routes (`routes.ts:146→153`, `:220→227`), so a non-holder cannot probe which keys
exist (US-3/ADR-0028 "must not even learn the mailbox exists"); `fetchCurrentSettingValue` is the
*single* live-read seam so "live" can't mean two things across the send path (`repo.ts:70-84`);
and `email.ts` treats a settings-repo read failure as unconfigured — failing toward the safe,
distinguishable `blocked_unconfigured` refusal rather than risking a silent misdirection
(`email.ts:52-58`), a deliberate, documented choice. No hallucinated APIs; ADRs 0027/0028/0029
written (0029 correctly amends 0021 in place). Minor, non-capping, and honestly disclosed: T4's
commit body notes it also repaired a pre-existing broken `bun-types` devDependency that was
breaking `bun run typecheck` project-wide — a tangential fix, correctly scoped and called out.

### Trajectory — 3/5 (below 5, above floor)
No `wellforge-run/v1` trace exists for 011 (verified: no `011`/`refund-settings` entries in
`.forge/runs/`; 0 `011` matches in `.events.jsonl`), so this is not scored 4–5 on trace evidence,
per the rubric convention. Git history nonetheless independently corroborates a clean,
correctly-ordered run: ADRs 0027–0029 committed (`8de38be`) BEFORE the T1–T7 per-task commits in
dependency order, then the T8 e2e (`d5434d4`) — the orchestrator committed spec artifacts before
dispatching, deliberately not repeating the 009 branched-off-tip slip. Two human gates plus QE PASS
and OWASP PASS (0 findings) per the launching context. Held below 4 by two minor, caught-and-fixed
integration blemishes: a stale `router.test.tsx` "Mileage Rates"→"Refund" nav-label assertion
(left red on `main` by an earlier rename, not this feature's dev work) fixed during integration
(`b88ab0e`), and a tangential Changesets root-`package.json` `workspaces` mis-config corrected to
`lerna.json` (`02d5db8`). Both are hygiene, not output corruption; verification was not skipped.

### Non-blocking note (not a spec-011 defect)
The full `auth` `seed.test.ts` run shows 2 failures (`employeeRules` length 3 vs 0 at
`seed.test.ts:681`) — the identical pre-existing shared-dev-DB employee-role seed pollution the
009 and 010 evals both documented. Spec 011's T1 grants only to `admin`/`refund-admin` and never
touches the employee role; the settings-specific assertions (`seedSettingsAdminGrants`, 3 tests)
all pass in isolation. Worth a separate per-test-DB-reset cleanup ticket, out of scope for this
verdict.

## Recommended next step
- **PASS** → spec 011 may complete T9 and move to `done`. Gates align: QE PASS (all 19 ACs mapped,
  T8 e2e run live 2/2), OWASP PASS (0 findings), eval PASS 96/100.
- Carry two tracked, non-blocking follow-ups already noted above: (a) run the cutover `settings:seed`
  once at deploy with the current prod value, then remove `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` from
  the platform (the documented D7 runbook); (b) a test-infra ticket to reset the shared auth dev DB
  per-test so the two pre-existing `seed.test.ts` employee-pollution failures go green in the full suite.
