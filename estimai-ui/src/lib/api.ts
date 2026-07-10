/**
 * api — facade over the shell's shared session module (T13, specs/003-suite-shell).
 *
 * Before T13 this file OWNED the in-memory JWT cache + `apiFetch` interceptor
 * (ADR-0001) for estimai-ui alone. estimai-ui now runs as a Module Federation
 * remote inside the `shell` host (T12); the shell exposes that exact
 * implementation ONCE for the whole suite as `shell/session` (T4), extracted
 * verbatim from this file at that task. Every tool (estimai-ui, refund-ui, …)
 * now delegates here instead of holding its own JWT cache, so the ADR-0001
 * token is cached a single time for the whole suite and a suite-wide sign-out
 * (shell/session's `signOut`) invalidates it everywhere at once (AC-2.3/AC-2.4).
 *
 * `estimatesApi.ts` and the rest of estimai-ui — unchanged by this task —
 * keep importing `apiFetch`/`clearJwtCache` from `./api`; their tests mock
 * this module path directly (`vi.mock('./api', …)` / `vi.mock('../lib/api', …)`)
 * and never load this file's real body, so they needed no changes either.
 *
 * The full interceptor-contract test suite that used to live in this file's
 * `api.test.ts` (refresh-retry circuit, trusted-origin guard, sign-in
 * redirect on exhausted retry) now lives in shell/src/lib/session.test.ts,
 * ported at T4 from this file's original test suite — see that file for the
 * authoritative coverage. What remains testable here is the delegation
 * itself (see api.test.ts).
 */

export { apiFetch, clearJwtCache } from 'shell/session'
