import 'shell/tokens.css'
import { useSession } from 'shell/session'

/**
 * App — admin-ui's root component, exposed via Module Federation as `./App`
 * (see vite.config.ts's `exposes`) — what the shell's future `/admin/*`
 * catch-all route (a later task, per plan.md's shell-wiring list) will
 * mount.
 *
 * Minimal, authed-only placeholder (T13, specs/004-auth-roles-permissions —
 * "the scaffold only; real screens/routing are later tasks"): a heading
 * identifying the tool, a short coming-soon / proof-of-concept message, and
 * nothing else — no roles/departments/users/audit screens yet (those are
 * T14+). It is written to render only once the shell's `_authed` guard has
 * already confirmed a session exists before mounting this component —
 * mirrors the plan's federation contract ("no auth guard, no chrome" for
 * every remote) and refund-ui's `./App` (specs/003-suite-shell T15). No
 * inner TanStack Router either: there is nothing to navigate between on a
 * single static screen yet — a later task adds admin-ui's own inner router
 * (basepath `/admin`) once there are real Roles/Departments/Users/Audit
 * screens to route between (plan.md "New admin-ui remote").
 *
 * Demonstrates the shared session (ADR-0001/ADR-0006): reads the signed-in
 * user's name via the shell's shared `shell/session` module (`useSession`)
 * — the SAME in-memory JWT/session state the shell chrome and every other
 * tool reads, not a locally re-created auth client. Kept to a single line,
 * not a profile UI.
 *
 * Design-system consistency: imports `shell/tokens.css` as a side-effect
 * (federated CSS module) so the shared Operai fonts + palette CSS custom
 * properties are present regardless of whether this component runs inside
 * the shell (which already loads the same tokens globally — a harmless
 * duplicate `<style>` injection) or standalone (src/main.tsx, dev/test
 * bootstrap — where it's the ONLY source of the palette).
 *
 * Deliberate styling choice (mirrors refund-ui/src/App.tsx's ADR-candidate
 * exactly, same underlying reason): colors and fonts below are applied via
 * the shared stylesheet's plain CSS custom properties (`var(--text)`,
 * `var(--soft)`, `var(--disp)`, …) rather than Tailwind's palette-specific
 * utility classes (`text-text`, `font-disp`, …). Those utilities only exist
 * in a build that processed the tokens' `@theme` block through Tailwind's
 * compiler at BUILD time; `shell/tokens.css` is consumed here as a RUNTIME
 * federated import, which Tailwind's JIT in this project's own build never
 * sees. Standard Tailwind utilities (layout/spacing/type-scale — `mx-auto`,
 * `px-6`, `text-3xl`, …) are unaffected and used freely below, since those
 * ship with Tailwind itself and need no local `@theme`.
 */
export default function App() {
  const session = useSession()
  const displayName = session.data?.user?.name || session.data?.user?.email || null

  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-center" style={{ color: 'var(--text)' }}>
      <h1
        className="text-3xl font-bold"
        style={{ fontFamily: 'var(--disp)' }}
      >
        Admin
      </h1>
      <p className="mt-4 text-base" style={{ color: 'var(--soft)' }}>
        Coming soon — this is a proof-of-concept placeholder proving Admin loads as its
        own, independently deployed tool inside the Operai suite. Roles, departments,
        users, and the audit log ship in later tasks of this feature.
      </p>
      {displayName && (
        <p
          className="mt-6 text-sm"
          style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}
          data-testid="admin-signed-in-as"
        >
          Signed in as {displayName}
        </p>
      )}
    </div>
  )
}
