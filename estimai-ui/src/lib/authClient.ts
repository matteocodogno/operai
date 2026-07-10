/**
 * authClient — facade over the shell's shared session module (T13, specs/003-suite-shell).
 *
 * Before T13 this file created its own `better-auth/react` client instance
 * pointed at VITE_AUTH_URL. estimai-ui now runs as a Module Federation remote
 * inside the `shell` host (T12), and the shell exposes ONE better-auth client
 * for the whole suite via `shell/session` (T4, ADR-0001/ADR-0002) so every
 * tool shares the same session state and the same in-memory JWT cache
 * instead of each holding an independent copy.
 *
 * This file re-exports that shared client's session accessors under the
 * exact same `authClient.*` shape the rest of estimai-ui already calls
 * (`authClient.useSession()`, `authClient.getSession()`, `authClient.signOut()`
 * — see EstimatorApp.tsx, pages/EstimatesPage.tsx), so those call sites and
 * their tests (which mock `./lib/authClient` directly and never see this
 * file's internals) needed NO changes for this task. The user-menu / sign-out
 * UI that calls these is tool-scoped chrome that stays in estimai-ui per the
 * plan (T14 dedups the suite-level chrome separately — out of scope here).
 *
 * The real implementation — and its full test coverage (session resolution,
 * sign-out clearing the shared JWT cache) — lives in shell/src/lib/session.ts
 * / shell/src/lib/session.test.ts.
 */

import { getSession, useSession, signOut } from 'shell/session'

export const authClient = {
  getSession,
  useSession,
  signOut,
}
