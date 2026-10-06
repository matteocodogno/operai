import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Dev/test-only standalone bootstrap (T24, specs/015-hardware-inventory): lets
// inventory-ui build, run, and test entirely on its own, outside the shell —
// mirrors refund-ui/src/main.tsx's standalone bootstrap. App itself
// (see App.tsx) already imports `shell/session` and `shell/tokens.css` as a
// federated remote, so standalone dev mode (`pnpm --dir inventory-ui dev`)
// requires the shell's dev server to actually be running to resolve those
// — same constraint the shell's own dev server has on estimai-ui/inventory-ui
// being up for its `/estimai`/`/inventory` routes to load (see
// shell/vite.config.ts's remote-URL comments). The shell mounts the
// federated remote directly (see vite.config.ts's `exposes`) instead of
// this bootstrap.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
