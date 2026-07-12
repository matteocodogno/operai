import 'shell/tokens.css'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from './router'

// IMPORTANT (mirrors estimai-ui/src/App.tsx's T12/specs/003-suite-shell doc
// exactly, same underlying reason): the exposed remote MUST NOT import its
// own `index.css` here. The shell owns the single Tailwind sheet for the
// whole suite; importing admin-ui's own compiled Tailwind here would put a
// SECOND full Tailwind sheet on the shell's page (the double-header /
// broken-responsive bug — see index.css's own doc comment). The standalone
// bootstrap (main.tsx) DOES import index.css: outside the shell there is no
// shell sheet, so it's admin-ui's only source of Tailwind + tokens.

/**
 * App — admin-ui's root component, exposed via Module Federation as `./App`
 * (see vite.config.ts's `exposes`) — what the shell's future `/admin/*`
 * catch-all route (per plan.md's shell-wiring list, a later task of this
 * feature) mounts.
 *
 * T14 (specs/004-auth-roles-permissions/tasks.md): replaces T13's static
 * placeholder with admin-ui's own inner TanStack Router (src/router.tsx),
 * rebased to basepath `/admin` — same federation contract estimai-ui's
 * `./App` (specs/003-suite-shell, T12/T13) already established:
 *
 *   admin-ui (remote)
 *     exposes:  ./App   # root component; inner TanStack Router with
 *                        # basepath '/admin'; no auth guard, no chrome
 *
 * Landing on `/admin` (or any admin path) renders AdminShell's section nav
 * (Roles/Departments/Users/Audit — src/components/SectionNav.tsx) + the
 * active section's placeholder page via `<Outlet/>` (src/components/
 * AdminShell.tsx). The real Roles/Departments/Users/Audit screens are
 * T17–T21; this task ships only the router + nav shell they mount into.
 *
 * Design-system consistency: imports `shell/tokens.css` as a side-effect
 * (federated CSS module) so the shared Operai fonts + palette CSS custom
 * properties are present regardless of whether this component runs inside
 * the shell (which already loads the same tokens globally — a harmless
 * duplicate `<style>` injection) or standalone (src/main.tsx, dev/test
 * bootstrap — where it's the ONLY source of the palette). AdminShell,
 * SectionNav, and the section pages all consume that palette via plain CSS
 * custom properties (`var(--text)`, `var(--soft)`, `var(--disp)`, …) rather
 * than Tailwind's palette-specific utility classes, for the same reason
 * documented on T13's original App.tsx: those utilities only exist in a
 * build that processed the tokens' `@theme` block through Tailwind's
 * compiler at BUILD time, and `shell/tokens.css` is consumed here as a
 * RUNTIME federated import that this project's own Tailwind build never
 * sees. Standard Tailwind utilities (layout/spacing/type-scale — `mx-auto`,
 * `px-6`, `text-3xl`, …) are unaffected and used freely, since those ship
 * with Tailwind itself and need no local `@theme`.
 */
const router = createAppRouter('/admin')

export default function App() {
  return <RouterProvider router={router} />
}
