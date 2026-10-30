---
spec: 016
evaluated: 2026-10-30
rubric: default-v2
score: 82
verdict: PASS
---
# Eval report: Every notify caller authenticates as itself; the shared token is retired

Rubric: the bundled copy at
`~/.claude/plugins/cache/wellforge/wellforge/2.56.0/config/eval-rubric.yml`, `version: default-v2`.
Neither `gates/configs/eval-rubric.yml` nor `.wellforge-gates/gates/configs/eval-rubric.yml` exists
in the repo. There is no `specs/016-notify-service-credentials/eval.md`, so no overrides apply.
`design_fidelity` is N/A because there is no `design.md` (no UI). The total is normalised over a
weight pool of 100.

What the evaluator ran at HEAD `15c35b4` (chore/016-close):
- `bun test` (single process, `direnv exec .`): notify-api 214/0, auth 566/0, refund-api 681/0,
  tools/env-doctor 99/0.
- estimai-api: 205 pass, 2 fail. Both failures are `orphaned-estimate.test.ts:389/470`, which hit
  P1000 "credentials for `postgres` are not valid" against the local auth DB. T22 names this as an
  environment fault, not a defect.
- `bun run typecheck` is clean in notify-api, auth, refund-api, estimai-api and inventory-api.
- `bash -n` is clean on `infra/check.sh` and `infra/deploy.sh`.
- `git grep NOTIFY_INTERNAL_TOKEN` (excluding adr/specs/.forge/changelogs/.changeset) returns only
  tools/env-doctor (the forbid rule and its tests) and the rollout history in `infra/README.md`.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | See the AC map below. Every AC is met. AC-5.4 (e2e 14/14) and AC-5.5 (check.sh 48 ok, env-doctor --live) rest on run traces and the user's production report; the evaluator did not reproduce them. AC-3.2/4.1/4.4 were proven by transition tests that T14 replaced by design. |
| Spec fidelity | 20 | 4 | 3 | 16.0 | Contracts match plan § API contracts. `systemAuth.middleware.ts` (one 401 body, scope per route, origin bindings, `caller=<sub>` log). `selfServiceToken.ts` and `mintServiceJwt` (shared path, reserved id `auth`). Copied `serviceToken.ts` in refund-api and estimai-api. Small recorded drift: `refund-api/src/lib/notifyPost.ts` and `tools/env-doctor/local.ts` sit outside their touch lists. Unrequested but user-approved scope: the gitleaks→betterleaks migration (798af6a). |
| Test quality | 20 | 4 | 3 | 16.0 | Tests assert side effects, not just status codes. `systemAuth.routes.test.ts:225/242`: wrong scope, expired, other aud or user aud gives 401, one body, 0 rows. Log privacy is tested through the real routes (`systemAuth.logPrivacy.test.ts:58`). Retry-once and no-loop are tested (refund `notify.test.ts:176/190`). Route-level AC-4.3 is covered for 401/429 (refund `review/decide.routes.test.ts:605`, `batches.routes.test.ts:1125`; estimai `collaborators.routes.test.ts:1521`). `retiredToken.test.ts` scans every service's src/ with a non-vacuity guard. Gaps: below. |
| Code quality | 15 | 4 | 3 | 12.0 | Idiomatic and copied from the reference: single-flight cache, 5 s timeout, `redirect: "error"`, body cancelled before retry, failures mapped to existing results and never thrown. Env exits name the variable. No hallucinated APIs (typecheck clean). Nits below. |
| Design fidelity | 15 | N/A | 3 | — | No `design.md` (backend/infra feature). |
| Trajectory | 10 | 5 | 2 | 10.0 | 12 `wellforge-run/v3` traces. Every implement batch ran owasp-reviewer and quality-engineer. QE FAIL on 2026-10-17 was fixed and re-verified. The T12 run blocked on 2026-10-30T09-10 for out-of-scope product defects, which were fixed on main and re-run (16-03-40Z: QE PASS, security PASS). Latest is 17-00-00Z, QE PASS, security PASS WITH NOTES. Person-only tasks T6/T11/T13/T18 have no agent run. Drift events are recorded with resolutions. Push order matches git (8c55bad, then 0b3b843, then 81f0af0/b4558b1). |
| **Total** | | | | **82/100** | |

**Verdict: PASS.** 82 is at or above the pass score of 80, and every applicable dimension is at or
above its floor (AC satisfaction 4/4 is exactly at its floor).

## AC map (abridged)

- AC-1.1 and AC-1.2: refund `notify.test.ts:163` (Bearer, no X-Internal-Token). Both push and both
  email call sites go through `notifyPost.ts`.
- AC-1.3: estimai `notify.test.ts:77/197`.
- AC-1.4: auth `notify.test.ts:42`, plus `self-service-token.contract.test.ts:40` (real better-auth
  signer and JWKS).
- AC-1.5: `systemAuth.middleware.test.ts:297/310` and `systemAuth.logPrivacy.test.ts:58`.
- AC-1.6: `serviceToken.routes.test.ts:137`.
- AC-2.1: env-doctor `check.test.ts:396/406`, plus `SELF_SERVICE_SCOPES = ["emails.send"]`.
- AC-2.2 to AC-2.5: `systemAuth.routes.test.ts:225/242/259`, `emails.routes.test.ts:252`, and
  `serviceJwt.isolation.test.ts:49`.
- AC-2.6: `serviceClients.test.ts:88/99`.
- AC-3.1: `systemAuth.routes.test.ts:204` (every template).
- AC-3.2, AC-4.1, AC-4.4: transition matrix in f6e40e2 (T3), replaced by refusal tests at T14 as
  planned. Production observation of `caller=shared-token` at T6.
- AC-4.2: refund and estimai `env.test.ts` (`SERVICE_CLIENT_*` missing or short makes the service
  exit, naming the variable).
- AC-4.3: route tests above, plus auth `notify.test.ts:59`.
- AC-5.1: `systemAuth.routes.test.ts:285/294`, `emails.routes.test.ts:239`, and `check.sh:167`.
- AC-5.2: `serviceJwt.isolation.test.ts:127` and `retiredToken.test.ts`.
- AC-5.3: env-doctor `check.test.ts:341–433`.
- AC-5.4: T12 e2e 14/14 (trace 16-03-40Z).
- AC-5.5: T18, user-run check.sh and env-doctor `--live`.
- AC-6.1 and AC-6.2: `infra/README.md` § Notify credential rollout. The confirmation step greps
  the `caller=` lines only (README:1426).

## Findings

- **AC satisfaction (4, at the floor).** No AC is unmet. The score stops short of 5 for three
  reasons:
  - The production ACs (AC-5.5, and the production half of AC-4.4) rest on the user's report and
    were not observed by the evaluator.
  - AC-5.4's e2e was not re-run here (it needs the full local stack). Only the trace records it.
  - AC-3.2/4.1/4.4 can no longer be re-proven at HEAD: their transition tests were removed on
    purpose at T14, so the evidence is historical (f6e40e2) plus the T6 production log.
  - The way to reach 5 is a fresh, recorded `pnpm e2e` run of the five journeys against the final
    stack.
- **Spec fidelity (4).**
  - The betterleaks migration and `.betterleaksignore` (798af6a, 584b250) are outside the spec's
    scope. The user requested them and they are recorded, so this is harmless, but they are still
    unrequested by the spec.
  - The two product fixes (46e108f refund-ui, 7260f31 estimai-ui) landed outside the feature, on
    main, and were recorded as resolved drift.
  - `infra/README.md:1325` still describes `NOTIFY_INTERNAL_TOKEN` in present-tense rollout terms
    ("Optional in notify-api from push 1"). T16's done-when allows this as rollout history, but the
    section does not say up front that the rollout is complete.
- **Test quality (4).**
  - auth's AC-4.3 is proven only in pieces: `notify.test.ts:59` (provider failure gives `failed`),
    plus an invitation route test that mocks `sendInvitationEmail` (`invitations.routes.test.ts:437`).
    No test drives the real client with a rejecting provider through the invitation route, unlike
    refund-api and estimai-api.
  - The traces (2026-10-17, 2026-10-29) record residual process-wide `mock.module` coupling in
    notify-api, refund-api and estimai-api. Single-process runs are green today, but
    order-dependence is still possible for new tests.
  - estimai-api's full run is not green on this machine because of the auth-DB credential fault.
- **Code quality (4).**
  - Two low env-doctor notes are accepted and not fixed: `local.ts` ambient-env masking, and
    `check.ts` printing raw URLs.
  - `serviceToken.ts` is now copied into three services. This is deliberate (no workspace, plan
    § 4), but it is a maintenance surface with no drift guard between the copies.
  - auth's `sendInvitationEmail` has no invalidate-and-retry on a 401, unlike the other callers.
    The in-process mint makes a stale token unlikely, but a 401 there (for example after a key
    rotation that notify-api's JWKS cache has not picked up) costs a manual resend.

## Recommended next step

- PASS. Spec 016 may move to `done` (T19: `/wellforge:done 016-notify-service-credentials`).
- Optional follow-ups, not required to close:
  - an auth invitation-route test with the real notify client and a rejecting provider;
  - a one-line "rollout complete (push 3, 2026-10-30)" marker at the top of the `infra/README.md`
    rollout section;
  - the two recorded env-doctor notes.
