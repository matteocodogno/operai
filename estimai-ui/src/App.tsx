import { RouterProvider } from '@tanstack/react-router'
import { createAppRouter } from './router'

// T12 (specs/003-suite-shell/tasks.md): root component exposed via Module
// Federation as `./App` (see vite.config.ts's `exposes`). This is what the
// shell's `/estimai/*` catch-all route (T9) mounts. The inner TanStack
// Router is rebased to basepath '/estimai' so estimai-ui's own internal
// navigation (list ↔ editor ↔ share) resolves correctly once mounted under
// that prefix — per the plan's federation contract:
//
//   estimai-ui (remote)
//     exposes:  ./App   # root component; inner TanStack Router with
//                        # basepath '/estimai'; no auth guard, no chrome
//
// T13 (specs/003-suite-shell/tasks.md, AC-2.3): the router's own `_authed`
// guard is gone — the shell's guard (shell/src/router.tsx, T9) already
// resolves the session before this component is ever mounted (see
// src/router.tsx's file-level doc for the full rationale).
//
// Still deliberately unchanged here (out of scope for T13):
//   - EstimAI's own chrome (Header/UserMenu/etc.) still renders (T14 dedups
//     it against the shell's chrome).
const router = createAppRouter('/estimai')

export default function App() {
  return <RouterProvider router={router} />
}
