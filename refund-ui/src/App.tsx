import 'shell/tokens.css'
import { useSession } from 'shell/session'

/**
 * App — refund-ui's root component, exposed via Module Federation as `./App`
 * (see vite.config.ts's `exposes`) — what the shell's `/refund/*` catch-all
 * route (T9, RemoteMount) mounts.
 *
 * Minimal, authed-only placeholder (US-5, AC-5.2, design.md "Refund
 * (Rimborsi) placeholder"): a heading identifying the tool, a short
 * coming-soon / proof-of-concept message, and nothing else — no forms, no
 * reimbursement domain (explicit spec non-goal; requests/expense
 * lines/approvals are later specs). It renders only because the shell's
 * `_authed` guard (T9) has already confirmed a session exists before
 * mounting this component — mirrors the plan's federation contract ("no
 * auth guard, no chrome" for every remote) and estimai-ui's `./App`
 * (T12/estimai-ui/src/App.tsx). No inner TanStack Router either: there is
 * nothing to navigate between on a single static screen, so `basepath:
 * '/refund'` has no route tree to apply to yet — a future task adds one
 * once there's real Refund content to route between.
 *
 * Demonstrates the shared session (ADR-0001/ADR-0006, AC-2.3): reads the
 * signed-in user's name via the shell's shared `shell/session` module
 * (`useSession`, T4) — the SAME in-memory JWT/session state EstimAI and the
 * shell chrome read, not a locally re-created auth client. Kept to a single
 * line, not a profile UI.
 *
 * Design-system consistency (AC-1.3): imports `shell/tokens.css` as a
 * side-effect (federated CSS module, T3) so the shared Operai fonts +
 * palette CSS custom properties are present regardless of whether this
 * component runs inside the shell (which already loads the same tokens
 * globally — a harmless duplicate `<style>` injection) or standalone
 * (src/main.tsx, dev/test bootstrap — where it's the ONLY source of the
 * palette).
 *
 * Deliberate styling choice (ADR-candidate — see this task's final report):
 * colors and fonts below are applied via the shared stylesheet's plain CSS
 * custom properties (`var(--text)`, `var(--soft)`, `var(--disp)`, …) rather
 * than Tailwind's palette-specific utility classes (`text-text`, `font-disp`,
 * …). Those utilities only exist in a build that processed the tokens'
 * `@theme` block through Tailwind's compiler at BUILD time; `shell/tokens.css`
 * is consumed here as a RUNTIME federated import, which Tailwind's JIT in
 * this project's own build never sees. Reaching for the custom utility
 * classes without a local copy of the `@theme` block would silently produce
 * unstyled markup. Standard Tailwind utilities (layout/spacing/type-scale —
 * `mx-auto`, `px-6`, `text-3xl`, …) are unaffected and used freely below,
 * since those ship with Tailwind itself and need no local `@theme`.
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
        Refund (Rimborsi)
      </h1>
      <p className="mt-4 text-base" style={{ color: 'var(--soft)' }}>
        Coming soon — this is a proof-of-concept placeholder proving Refund loads as its
        own, independently deployed tool inside the Operai suite. The reimbursement
        workflow itself ships in a later spec.
      </p>
      {displayName && (
        <p
          className="mt-6 text-sm"
          style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}
          data-testid="refund-signed-in-as"
        >
          Signed in as {displayName}
        </p>
      )}
    </div>
  )
}
