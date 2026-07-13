import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Dev/test-only standalone bootstrap (T14, specs/005-notification-center):
// lets notify-ui build, run, and test entirely on its own, outside the shell
// — mirrors admin-ui/src/main.tsx's and refund-ui/src/main.tsx's standalone
// bootstrap exactly. App itself (see App.tsx) already imports `shell/session`
// and `shell/tokens.css` as a federated remote, so standalone dev mode
// (`pnpm --dir notify-ui dev`) requires the shell's dev server to actually be
// running to resolve those — same constraint the shell's own dev server has
// on estimai-ui/refund-ui/admin-ui being up for its `/estimai`/`/refund`/
// `/admin` routes to load (see shell/vite.config.ts's remote-URL comments).
// The shell mounts the federated remote directly (see vite.config.ts's
// `exposes`) instead of this bootstrap.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
