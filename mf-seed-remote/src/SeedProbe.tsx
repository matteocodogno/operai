import { useEffect, useState } from 'react'
import * as ReactRuntime from 'react'

/**
 * T2 federation probe — throwaway/seed remote.
 *
 * This is NOT a real Operai tool. It exists solely to prove the Module
 * Federation walking skeleton (specs/003-suite-shell/tasks.md, T2 — the R1
 * gate): that the shell host can load a remote's exposed component at
 * runtime, and that `react`/`react-dom` resolve to a single shared instance
 * across the host↔remote boundary (ADR-0006, R1/R2).
 *
 * It is superseded by the real `refund-ui` remote in T15 and should be
 * deleted once that lands, or left as a minimal harness for future R1-style
 * regressions — do not add product features here.
 *
 * Proof strategy:
 *  - `useState`/`useEffect` are real hooks. If the host and this remote ended
 *    up with two separate `react` module instances (the classic MF failure
 *    mode), React would throw "Invalid hook call" the moment this component
 *    rendered under the host's react-dom reconciler — so a clean render is
 *    itself part of the evidence, not just a visual check.
 *  - On mount, this component reports its own `react` module object to the
 *    host via `onReady`. The host compares that object, by reference
 *    (`===`), to the `react` module *it* imported. Reference equality is
 *    only possible if both bundles resolved to the exact same module
 *    instance (i.e. the MF `shared`/`singleton: true` negotiation worked).
 */
export interface SeedProbeProps {
  onReady?: (remoteReact: typeof ReactRuntime) => void
}

export default function SeedProbe({ onReady }: SeedProbeProps) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    onReady?.(ReactRuntime)
    // Only report once, on mount — onReady identity is not expected to be stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div data-testid="seed-probe">
      <p>mf-seed-remote: exposed component rendered by the shell (T2)</p>
      <button
        type="button"
        data-testid="seed-probe-increment"
        onClick={() => setCount((c) => c + 1)}
      >
        remote hook count: {count}
      </button>
    </div>
  )
}
