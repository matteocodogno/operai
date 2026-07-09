import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import { createAppRouter } from './router'

// Dev/test-only standalone bootstrap (T12, specs/003-suite-shell): kept so
// estimai-ui still builds, runs, and tests entirely on its own, outside the
// shell. No basepath — routes resolve at the document root exactly as
// before this task. The shell mounts the federated remote instead (see
// src/App.tsx, exposed as `./App`), which rebases the same router under
// `/estimai`.
const router = createAppRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
