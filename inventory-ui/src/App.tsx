import 'shell/tokens.css'
import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from './router'

// IMPORTANT (same reason as refund-ui/src/App.tsx): the exposed remote MUST NOT
// import its own `index.css` here. The shell owns the single Tailwind sheet for
// the whole suite; a second compiled sheet on the shell's page causes the
// double-header / broken-responsive bug. Only the standalone bootstrap
// (main.tsx) imports index.css.

/**
 * App — inventory-ui's gated tool root, exposed via Module Federation as
 * `./App` (vite.config.ts `exposes`) and mounted by the shell at the
 * access-gated `/inventory/*` (ADR-0006, ADR-0045). It owns an inner TanStack
 * Router rebased to `/inventory`; no auth guard and no chrome (the shell owns
 * both). T28 passes its `InventoryShell` as the second argument below.
 *
 * Imports `shell/tokens.css` as a side effect so the shared Operai fonts and
 * palette custom properties are present inside the shell and standalone alike;
 * components consume them as plain `var(--…)` values (see refund-ui/src/App.tsx
 * for why Tailwind palette utilities are not used for them).
 */
const router = createAppRouter('/inventory')

export default function App() {
  return <RouterProvider router={router} />
}
