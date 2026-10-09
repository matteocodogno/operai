/**
 * Cheap, static complement to remoteVersionExposes.integration.test.ts (QE
 * finding on the version-bump feature, chore/version-release-enforcement).
 *
 * The integration test loads each remote's OWN built `dist/remoteEntry.js`
 * directly by filesystem path — it proves the remote's `exposes`/
 * `src/version.ts` wiring is correct in isolation, but it never touches the
 * shell's SIDE of the contract: the shell only ever resolves a remote's
 * version via the bare specifier `import('<id>/version')`
 * (useRemoteVersions.ts), which depends on THREE independently-edited things
 * agreeing on the same `<id>`:
 *   1. useRemoteVersions.ts's REMOTE_VERSION_SOURCES ids
 *   2. shell/src/federation/remotes.d.ts's ambient `declare module
 *      '<id>/version'` declarations (so `tsc` doesn't reject the specifier)
 *   3. shell/vite.config.ts's own `remotes: { <id>: { name: '<id>', ... } }`
 *      federation config, which must itself match the remote's OWN
 *      `federation({ name: '<id>', ... })` in its vite.config.ts — a
 *      mismatch here is a real, easy-to-make failure mode (rename a remote's
 *      `name:` and forget the shell's `remotes` key, or vice versa) that the
 *      integration test's direct-by-path loading cannot see, since it never
 *      goes through the shell's remote-name resolution at all.
 *
 * A real end-to-end proof of #3 needs a browser actually fetching a real
 * cross-origin remoteEntry.js (shell/e2e's webServer harness, not exercised
 * here — see the integration test's doc comment for why that's out of scope
 * for this defect). This file is the deterministic, no-servers-needed next
 * best thing: assert the four sources of truth agree on paper.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REMOTE_VERSION_SOURCES } from '../hooks/useRemoteVersions'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const REMOTE_DIRS: Record<(typeof REMOTE_VERSION_SOURCES)[number]['id'], string> = {
  estimai: 'estimai-ui',
  refund: 'refund-ui',
  admin: 'admin-ui',
  notify: 'notify-ui',
  inventory: 'inventory-ui',
}

const remotesDtsSource = readFileSync(path.join(__dirname, 'remotes.d.ts'), 'utf-8')
const shellViteConfigSource = readFileSync(path.resolve(__dirname, '../../vite.config.ts'), 'utf-8')

describe.each(REMOTE_VERSION_SOURCES)(
  "'$id' — the id agrees across useRemoteVersions, remotes.d.ts, and both sides' vite.config.ts",
  ({ id }) => {
    it(`remotes.d.ts declares 'declare module '${id}/version''`, () => {
      expect(remotesDtsSource).toContain(`declare module '${id}/version'`)
    })

    it(`shell/vite.config.ts's federation host config declares a '${id}' remote named '${id}'`, () => {
      // Matches e.g. `estimai: {\n  type: 'module',\n  name: 'estimai',`
      // Loose on whitespace/comments between the two lines, strict on the
      // key and the `name:` value actually matching.
      const remoteBlockRe = new RegExp(`\\b${id}:\\s*\\{[^}]*name:\\s*'${id}'`, 's')
      expect(shellViteConfigSource).toMatch(remoteBlockRe)
    })

    // inventory-ui is built by later tasks of specs/015 (T2+); until its
    // vite.config.ts exists there is nothing on the remote side to compare, so
    // the shell-side checks above are the only ones that can run.
    const remoteViteConfigPath = path.resolve(__dirname, '../../../', REMOTE_DIRS[id], 'vite.config.ts')
    it.skipIf(!existsSync(remoteViteConfigPath))(`${REMOTE_DIRS[id]}/vite.config.ts's federation() call self-identifies as name: '${id}' and exposes './version'`, () => {
      const source = readFileSync(remoteViteConfigPath, 'utf-8')
      expect(source).toMatch(new RegExp(`federation\\(\\{\\s*name:\\s*'${id}'`, 's'))
      expect(source).toMatch(/exposes:\s*\{[^}]*'\.\/version':\s*'\.\/src\/version\.ts'/s)
    })
  },
)

it('REMOTE_VERSION_SOURCES covers exactly the five known remote directories, no more, no less', () => {
  expect(new Set(REMOTE_VERSION_SOURCES.map((s) => s.id))).toEqual(new Set(Object.keys(REMOTE_DIRS)))
})

// specs/015-hardware-inventory, T41 (ADR-0045): inventory-ui exposes TWO
// entries besides ./version — the gated ./App and the ungated ./MyDevices —
// so the shell declares both ambient modules.
describe("'inventory' — the two federated entries are declared for tsc", () => {
  it.each(['inventory/App', 'inventory/MyDevices'])("remotes.d.ts declares '%s'", (specifier) => {
    expect(remotesDtsSource).toContain(`declare module '${specifier}'`)
  })
})

// The shell's CSP must let the page load the inventory remote's script and
// reach its API (AC-9.6 wiring). Hosts follow the suite's `<name>[-api].operai.welld.io` scheme.
describe('vercel.json CSP — inventory origins', () => {
  const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf-8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }
  const csp =
    vercel.headers
      .flatMap((h) => h.headers)
      .find((header) => header['key'] === 'Content-Security-Policy')?.value ?? ''
  const directive = (name: string): string =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? ''

  it('script-src allows the inventory remote origin', () => {
    expect(directive('script-src')).toContain('https://inventory.operai.welld.io')
  })

  it('connect-src allows the inventory remote and inventory-api origins', () => {
    expect(directive('connect-src')).toContain('https://inventory.operai.welld.io')
    expect(directive('connect-src')).toContain('https://inventory-api.operai.welld.io')
  })
})

describe('runtime-config.example.json', () => {
  it('lists the inventory remote entry', () => {
    const example = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../public/runtime-config.example.json'), 'utf-8'),
    ) as Record<string, string>
    expect(example['inventory']).toBe('https://inventory.operai.welld.io/remoteEntry.js')
  })
})
