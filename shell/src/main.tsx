import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { registerRemotes } from '@module-federation/runtime'
import './index.css'
import { router } from './router'
import { resolveRuntimeRemotes } from './lib/runtimeRemotes'

// T17 (specs/003-suite-shell/tasks.md, AC-5.3): resolve remote entry
// overrides at RUNTIME (see src/lib/runtimeRemotes.ts) before the router
// mounts and before any route's `beforeLoad`/component can trigger the
// first `import('estimai/App')` / `import('refund/App')` — `registerRemotes`
// with `force: true` only takes effect if called before a remote's first
// load. When no runtime config is present (local dev, the T16 e2e suite),
// `resolveRuntimeRemotes()` resolves to an empty array and this is a no-op:
// the remotes declared in vite.config.ts (ESTIMAI_REMOTE_URL/
// REFUND_REMOTE_URL, build-time) govern exactly as before this task.
async function bootstrap() {
  const runtimeRemotes = await resolveRuntimeRemotes()
  if (runtimeRemotes.length > 0) {
    registerRemotes(runtimeRemotes, { force: true })
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}

void bootstrap()
