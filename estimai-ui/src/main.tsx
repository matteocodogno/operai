import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import { createAppRouter } from './router'

// Dev/test-only standalone bootstrap (T12, specs/003-suite-shell): kept so
// estimai-ui still builds and tests entirely on its own, outside the shell.
// No basepath — routes resolve at the document root exactly as before this
// task. The shell mounts the federated remote instead (see src/App.tsx,
// exposed as `./App`), which rebases the same router under `/estimai`.
//
// STANDALONE-DEV LIMITATION (T13, specs/003-suite-shell/tasks.md, AC-2.3):
// since T13, src/lib/api.ts and src/lib/authClient.ts import the federated
// `shell/session` module instead of holding their own JWT cache / better-auth
// client. Running `pnpm dev` in estimai-ui alone (no shell dev server
// serving `shell/session` at SHELL_REMOTE_URL) can therefore no longer
// resolve a real session at runtime — this router also no longer runs its
// own `_authed` guard/sign-in redirect (that responsibility moved to the
// shell, AC-2.3), so this standalone bootstrap renders unauthenticated with
// API calls failing rather than redirecting anywhere. This is an accepted
// limitation, not a regression to fix here: production reaches EstimAI only
// through the shell (AC-4.3), and `pnpm test`/`pnpm build` stay green via the
// vitest alias + ambient module declaration (see vitest.config.ts,
// src/federation/remotes.d.ts). Run the shell (`pnpm --dir shell dev`)
// alongside `pnpm dev` here to exercise this bootstrap with a real session.
const router = createAppRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
