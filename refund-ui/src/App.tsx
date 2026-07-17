import 'shell/tokens.css'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from './router'

// IMPORTANT (mirrors admin-ui/src/App.tsx's/estimai-ui/src/App.tsx's doc
// exactly, same underlying reason): the exposed remote MUST NOT import its
// own `index.css` here. The shell owns the single Tailwind sheet for the
// whole suite; importing refund-ui's own compiled Tailwind here would put a
// SECOND full Tailwind sheet on the shell's page (the double-header /
// broken-responsive bug — see index.css's own doc comment). The standalone
// bootstrap (main.tsx) DOES import index.css: outside the shell there is no
// shell sheet, so it's refund-ui's only source of Tailwind + tokens.

/**
 * App — refund-ui's root component, exposed via Module Federation as `./App`
 * (see vite.config.ts's `exposes`) — what the shell's `/refund/*` catch-all
 * route mounts.
 *
 * T14 (specs/007-refund-service/tasks.md): replaces the T15/specs/003
 * static placeholder with refund-ui's own inner TanStack Router
 * (src/router.tsx), rebased to basepath `/refund` — same federation contract
 * admin-ui's/estimai-ui's `./App` already establish:
 *
 *   refund-ui (remote)
 *     exposes:  ./App   # root component; inner TanStack Router with
 *                        # basepath '/refund'; no auth guard, no chrome
 *
 * Landing on `/refund` (or any refund path) renders `RefundShell`'s heading
 * + two-item nav (My requests / Review queue — src/components/RefundShell.tsx)
 * + the active route's placeholder page via `<Outlet/>`. The real screens
 * (composer, attachments, review/decide) are T15–T18; this task ships only
 * the router + shell they mount into.
 *
 * Demonstrates the shared session/design tokens exactly as the prior
 * placeholder did (ADR-0001/ADR-0006): imports `shell/tokens.css` as a
 * side-effect so the shared Operai fonts + palette CSS custom properties are
 * present regardless of whether this component runs inside the shell or
 * standalone (src/main.tsx). `RefundShell` and every page below consume that
 * palette via plain CSS custom properties (`var(--text)`, `var(--soft)`,
 * `var(--disp)`, …) rather than Tailwind's palette-specific utility classes,
 * for the same reason documented on the placeholder's original App.tsx:
 * those utilities only exist in a build that processed the tokens' `@theme`
 * block through Tailwind's compiler at BUILD time, and `shell/tokens.css` is
 * consumed here as a RUNTIME federated import that this project's own
 * Tailwind build never sees. Standard Tailwind utilities (layout/spacing/
 * type-scale) are unaffected and used freely.
 *
 * No explicit `useSession()`/"signed in as" demonstration here (unlike the
 * T15 placeholder) — `RefundShell` mirrors `AdminShell`'s posture exactly:
 * identity display is suite chrome the shell already owns (Header/UserMenu),
 * not something this remote's own root re-derives.
 */
const router = createAppRouter('/refund')

export default function App() {
  return <RouterProvider router={router} />
}
