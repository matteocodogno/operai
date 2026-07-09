// R1 GATE (specs/003-suite-shell/tasks.md, T2): ambient module declaration for
// the throwaway `seed` remote's exposed component. Module Federation resolves
// `seed/SeedProbe` at runtime via a virtual module the host's TypeScript
// program cannot see, so without this declaration `tsc` reports TS2307
// ("Cannot find module"). A real remote (T12 estimai-ui, T15 refund-ui) would
// get this from `@module-federation/vite`'s `dts` generation instead of a
// hand-written ambient declaration — disabled here (see mf-seed-remote/vite.config.ts)
// because it is unnecessary ceremony for a probe that is deleted/superseded once
// T15 lands.
declare module 'seed/SeedProbe' {
  import type { ComponentType } from 'react'

  export interface SeedProbeProps {
    onReady?: (remoteReact: typeof import('react')) => void
  }

  const SeedProbe: ComponentType<SeedProbeProps>
  export default SeedProbe
}
