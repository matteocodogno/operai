import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { registerRemotes } from '@module-federation/runtime'
import './index.css'
import { router } from './router'
import { resolveRuntimeRemotes } from './lib/runtimeRemotes'
import { registerSuiteNavigate } from './lib/session'

// Follow-up to specs/005-notification-center (T15/AC-2.5): registers this
// shell's real router.navigate as the suite-wide cross-remote navigation
// function (session.ts's `navigateSuite` seam) — see that file's doc comment
// for why the registration happens here rather than session.ts importing the
// router directly (avoids a session↔router import cycle). `to` is a runtime
// string (an in-suite absolute path read off a notification's `link.href`,
// not a value known to TanStack Router's generated route-tree types at build
// time), so it needs the same kind of cast the codebase already uses for
// other dynamic `to` values (e.g. router.tsx's `redirect({ to:
// resolveLastToolPath() })`, Sidebar's `SuiteTool.to: string`) — TanStack's
// `navigate({ to })` overload set expects a statically-known route literal.
registerSuiteNavigate((to) => {
  void router.navigate({ to })
})

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
