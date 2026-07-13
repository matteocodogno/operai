import 'shell/tokens.css'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from './router'

// IMPORTANT (mirrors admin-ui/src/App.tsx's and estimai-ui/src/App.tsx's
// documented reason exactly): the exposed remote MUST NOT import its own
// `index.css` here. The shell owns the single Tailwind sheet for the whole
// suite; importing notify-ui's own compiled Tailwind here would put a SECOND
// full Tailwind sheet on the shell's page (the double-header / broken-
// responsive bug — see index.css's own doc comment, ADR-0006 addendum). The
// standalone bootstrap (main.tsx) DOES import index.css: outside the shell
// there is no shell sheet, so it's notify-ui's only source of Tailwind +
// tokens.

/**
 * App — notify-ui's root component, exposed via Module Federation as `./App`
 * (see vite.config.ts's `exposes`) — what the shell's `/notify/*` always-
 * available catch-all route (T13, a later task of this feature) mounts.
 *
 * T14 (specs/005-notification-center/tasks.md): scaffold-only. Gives
 * notify-ui its own inner TanStack Router (src/router.tsx) rebased to
 * basepath `/notify` — same federation contract every other remote already
 * established (admin-ui's `./App`, T13/T14 of specs/004-auth-roles-
 * permissions):
 *
 *   notify-ui (remote)
 *     exposes:  ./App   # root component; inner TanStack Router with
 *                        # basepath '/notify'; no auth guard, no chrome
 *
 * Landing on `/notify` renders NotificationCenterPage — a placeholder for
 * now (this task ships only the router + page shell it mounts into; the
 * real notification list/empty/loading/error states and the "mark all as
 * read" control are T15, plan.md "Architecture → notify-ui" / design.md
 * "Notification center page").
 *
 * No auth guard here either — same rationale as every other remote's inner
 * router (estimai-ui/admin-ui/refund-ui, ADR-0006): the shell's own
 * `_authed` guard already runs before notify-ui is ever mounted, and per
 * plan.md/ADR-0007 `/notify` is deliberately NOT an app-access-gated route
 * (every signed-in user has notifications) — so there is no per-tool
 * `access` guard to add here either, unlike admin-ui.
 *
 * Design-system consistency: imports `shell/tokens.css` as a side-effect
 * (federated CSS module) so the shared Operai fonts + palette CSS custom
 * properties are present regardless of whether this component runs inside
 * the shell (which already loads the same tokens globally — a harmless
 * duplicate `<style>` injection) or standalone (src/main.tsx, dev/test
 * bootstrap — where it's the ONLY source of the palette). Components here
 * follow admin-ui's convention (plain CSS custom properties via inline
 * `style={{ color: 'var(--x)' }}`, not Tailwind's palette-specific utility
 * classes) since notify-ui's own build never processes `shell/tokens.css`'s
 * `@theme` block through Tailwind's compiler — see design.md's Component
 * inventory section for the two-conventions-coexist rationale. Standard
 * Tailwind utilities (layout/spacing/type-scale — `mx-auto`, `px-6`,
 * `text-3xl`, …) are unaffected and used freely, since those ship with
 * Tailwind itself and need no local `@theme`.
 */
const router = createAppRouter('/notify')

export default function App() {
  return <RouterProvider router={router} />
}
