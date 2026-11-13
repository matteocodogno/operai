import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Dev/test-only standalone bootstrap (specs/029-time-tracking), mirroring projects-ui/src/main.tsx.
// App imports `shell/session` and `shell/tokens.css` as a federated remote, so `pnpm --dir hours-ui dev`
// needs the shell's dev server running to resolve them. In the suite the shell mounts the exposed
// `./App` directly (vite.config.ts `exposes`), never this bootstrap.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
