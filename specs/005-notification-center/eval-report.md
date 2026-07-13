---
spec: 005
evaluated: 2026-07-13
rubric: default-v2
score: 95
verdict: PASS
---
# Eval report: Notification center

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | All 29 ACs (US-1..US-6) mapped + passing. Backend: `raise.routes.ts` (AC-4.1–4.5, sub-only recipient), `list.routes.ts` (AC-2.3/2.4/6.2 sub-scoping), `markRead.routes.ts` (AC-3.1/3.4 idempotent), `stream.routes.ts` (AC-1.4/1.5 ticket-auth SSE) — `bun test` 90 pass / 226 expects. FE: `Bell.tsx` `formatBadgeCount` (AC-1.2/1.3/1.6), `NotificationItem.tsx` was-unread (AC-3.2/3.3), `ToastHost.tsx` (AC-5.1/5.2/5.3/5.5) — notify-ui 22 pass. Live `shell/e2e/notifications.spec.ts` 10/10 against real stack covers AC-1.4/1.5/2.1/2.4/2.5/3.1/3.2/3.3/5.1/5.5/5.6/6.2/6.3. Every AC has a passing test AND observable behavior. |
| Spec fidelity | 20 | 5 | 3 | 20.0 | Zero product scope creep; contracts match `plan.md` §API contracts. The `aud` hardening (ADR-0010) touching auth+estimai-api was surfaced in plan R7 and approved at the plan gate — requested, not drift. Documented interpretations for the two spec ambiguities (AC-1.6 9/10 overlap → `count > 9 ? "9+"` matches Constraint wording; AC-3.2/3.3 → fresh viewing session per nav). `list.routes.ts:8-21` reports the tasks.md "not-owned 404" carry-over as inapplicable to a list-only contract rather than silently changing it. |
| Test quality | 20 | 5 | 3 | 20.0 | e2e uses control assertions to defeat vacuous passes (AC-5.5 asserts the toast appeared first, spec.ts:308-325), anchored URL regex to catch basepath mis-resolution (AC-2.5, spec.ts:235-239), and separates AC-2.5 navigation from specs/004 app-access. Backend covers single-use/expired/wrong-ticket 401, empty title/body 400, non-relative link, wrong/absent `aud`. Regression test added for the composition-leak ("*" middleware) via real assembled app. |
| Code quality | 15 | 5 | 3 | 15.0 | Idiomatic clones of estimai-api/admin-ui; Effect TS, RFC 7807, zod boundary enums, no hallucinated deps (jose/hono streaming/better-auth `definePayload` all real). Security-conscious: OWASP A01 recipient strip (`notifications.schemas.ts:12-26`), open-redirect guard (`isRelativeSuitePath`), logger drops the whole query string (`logger.ts`), SSE middleware scoped off `*` (`stream.routes.ts:55-63`). Careful details: circular-import lazy sign-out reg, EventSource single-use teardown + exponential backoff, React shorthand/longhand style-warning avoidance. |
| Design fidelity (UI) | 15 | 5 | 3 | 15.0 | `design.md` complete: all flows (1–7), every loading/populated/empty/error state, full a11y plan (focus-on-mount, ARIA role/live split, live-region badge, non-color affordances, reduced-motion, `role=list` guard), component inventory with reuse:NEW mapping (12:5), and a "Gaps found" section. Realised faithfully: `Bell.tsx` aria-live sibling + aria-hidden badge, `ToastHost.tsx` status/alert split + pause-on-hover/focus (WCAG 2.2.1) + `motion-reduce`, `NotificationItem.tsx` text+weight+border+sr-only "New:" (four channels), real cross-remote `<a href>` not `<Link>`. |
| Trajectory | 10 | 2 | 2 | 4.0 | No dedicated `.forge/runs/*.json` trace for 005 (events.jsonl has no 005 entries) → neutral floor per rubric note. Git history nonetheless shows a clean per-task trajectory (T1→T21 in dep order via worktree-agent merges) plus QE/OWASP-driven fixes (a2c8773 middleware+log fix, 014762e/ec770fd AC-2.5 hardening). |
| **Total** | | | | **95/100** | (109 weighted ÷ 115 applicable weight × 100 = 94.8) |

**Verdict: PASS** — 95 ≥ pass_score 80; every applicable dimension ≥ its floor (ac 5≥4, spec/test/code/design ≥3, trajectory 2≥2). No sub-floor dimension.

## Findings
- **Trajectory (2/5)** — the only below-5 dimension, and not a defect in the work. There is no run trace for feature 005 in `.forge/runs/`, so per the rubric's own note ("default to 2 (neutral) ONLY when no run trace exists") this scores the neutral floor. Git history corroborates a correct, ordered, QE-and-OWASP-reviewed trajectory; it simply isn't the observability-trace evidence anchors 4–5 require. Nothing to remediate.
- No unmet AC. No sub-floor dimension. The two spec ambiguities (AC-1.6 count boundary, AC-3.2 vs AC-3.3 was-unread lifetime) were flagged by plan/design and implemented against a documented, defensible interpretation — worth a one-line PO confirmation but non-blocking.

## Recommended next step
- PASS → spec 005 may complete T22 (`/wellforge:done 005`) and move to `done`.
