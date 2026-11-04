import 'shell/tokens.css'
import { RouterProvider } from '@tanstack/react-router'
import MeetingsShell from './components/MeetingsShell'
import { createAppRouter } from './router'

// The exposed remote MUST NOT import its own index.css: the shell owns the one
// Tailwind sheet of the suite (ADR-0006 addendum, ADR-0051). Only the
// standalone bootstrap (main.tsx) imports index.css.

/**
 * App — meetings-ui's gated tool root, exposed via Module Federation as `./App`
 * (vite.config.ts) and mounted by the shell at the access-gated `/meetings/*`
 * (specs/021-meetings). An inner TanStack Router rebased to `/meetings`, with
 * `MeetingsShell` as its root layout; no auth guard and no chrome (the shell owns both).
 */
const router = createAppRouter('/meetings', MeetingsShell)

export default function App() {
  return <RouterProvider router={router} />
}
