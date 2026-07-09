import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SeedProbe from './SeedProbe'

// Standalone dev/build bootstrap for the T2 federation probe — lets it be
// run and eyeballed on its own (`pnpm --dir mf-seed-remote dev`) without the
// shell host. The federation-relevant export is `./src/SeedProbe.tsx`,
// exposed as `seed/SeedProbe` via @module-federation/vite (see vite.config.ts).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SeedProbe />
  </StrictMode>,
)
