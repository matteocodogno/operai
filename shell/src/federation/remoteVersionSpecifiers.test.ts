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
  crm: 'crm-ui',
  meetings: 'meetings-ui',
  projects: 'projects-ui',
  letterheads: 'letterheads-ui',
  accounting: 'accounting-ui',
  hours: 'hours-ui',
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

    // inventory-ui is built by later tasks of specs/20261006-hardware-inventory (T2+); until its
    // vite.config.ts exists there is nothing on the remote side to compare, so
    // the shell-side checks above are the only ones that can run.
    const remoteViteConfigPath = path.resolve(__dirname, '../../../', REMOTE_DIRS[id], 'vite.config.ts')
    it.skipIf(!existsSync(remoteViteConfigPath))(
      `${REMOTE_DIRS[id]}/vite.config.ts's federation() call self-identifies as name: '${id}' and exposes './version'`,
      () => {
        const source = readFileSync(remoteViteConfigPath, 'utf-8')
        expect(source).toMatch(new RegExp(`federation\\(\\{\\s*name:\\s*'${id}'`, 's'))
        expect(source).toMatch(/exposes:\s*\{[^}]*'\.\/version':\s*'\.\/src\/version\.ts'/s)
      },
    )
  },
)

it('REMOTE_VERSION_SOURCES covers exactly the known remote directories, no more, no less', () => {
  expect(new Set(REMOTE_VERSION_SOURCES.map((s) => s.id))).toEqual(new Set(Object.keys(REMOTE_DIRS)))
})

// specs/20261006-hardware-inventory, T41 (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote): inventory-ui exposes TWO
// entries besides ./version — the gated ./App and the ungated ./MyDevices —
// so the shell declares both ambient modules.
describe("'inventory' — the two federated entries are declared for tsc", () => {
  it.each(['inventory/App', 'inventory/MyDevices'])("remotes.d.ts declares '%s'", (specifier) => {
    expect(remotesDtsSource).toContain(`declare module '${specifier}'`)
  })
})

// specs/20261104-meetings (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote shape, ADR 20261104-host-extension-federated-panel-through-the-shell): the meetings remote exposes three
// mountable entries besides ./version, and the shell exposes the host-extension seam.
describe("'meetings' — the federated entries are declared for tsc, and the seam is exposed", () => {
  it.each(['meetings/App', 'meetings/MyMeetings', 'meetings/HostMeetings'])(
    "remotes.d.ts declares '%s'",
    (specifier) => {
      expect(remotesDtsSource).toContain(`declare module '${specifier}'`)
    },
  )

  it("shell/vite.config.ts exposes './extensions' next to './session'", () => {
    expect(shellViteConfigSource).toMatch(/exposes:\s*\{[^}]*'\.\/extensions':\s*'\.\/src\/lib\/extensions\.tsx'/s)
  })
})

// The shell's CSP must let the page load the inventory remote's script and
// reach its API (AC-9.6 wiring). Hosts follow the suite's `<name>[-api].operai.welld.io` scheme.
describe('vercel.json CSP — inventory origins', () => {
  const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf-8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }
  const csp =
    vercel.headers.flatMap((h) => h.headers).find((header) => header['key'] === 'Content-Security-Policy')?.value ?? ''
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

// specs/20261101-crm: the shell's CSP lets the page load the CRM remote and reach crm-api.
describe('vercel.json CSP — crm origins', () => {
  const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf-8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }
  const csp =
    vercel.headers.flatMap((h) => h.headers).find((header) => header['key'] === 'Content-Security-Policy')?.value ?? ''
  const directive = (name: string): string =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? ''

  it('script-src allows the crm remote; connect-src the remote and crm-api', () => {
    expect(directive('script-src')).toContain('https://crm.operai.welld.io')
    expect(directive('connect-src')).toContain('https://crm.operai.welld.io')
    expect(directive('connect-src')).toContain('https://crm-api.operai.welld.io')
  })

  it("remotes.d.ts declares 'crm/App'", () => {
    expect(remotesDtsSource).toContain("declare module 'crm/App'")
  })
})

// specs/20261103-projects: the shell's CSP lets the page load the Projects remote and reach projects-api.
describe('vercel.json CSP — projects origins', () => {
  const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf-8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }
  const csp =
    vercel.headers.flatMap((h) => h.headers).find((header) => header['key'] === 'Content-Security-Policy')?.value ?? ''
  const directive = (name: string): string =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? ''

  it('script-src allows the projects remote; connect-src the remote and projects-api', () => {
    expect(directive('script-src')).toContain('https://projects.operai.welld.io')
    expect(directive('connect-src')).toContain('https://projects.operai.welld.io')
    expect(directive('connect-src')).toContain('https://projects-api.operai.welld.io')
  })

  it("remotes.d.ts declares 'projects/App'", () => {
    expect(remotesDtsSource).toContain("declare module 'projects/App'")
  })

  it('runtime-config.example.json lists the projects remote entry', () => {
    const example = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../public/runtime-config.example.json'), 'utf-8'),
    ) as Record<string, string>
    expect(example['projects']).toBe('https://projects.operai.welld.io/remoteEntry.js')
  })
})

// specs/20261116-letterhead-service: the shell's CSP lets the page load the Letterheads remote and reach letterhead-api.
describe('vercel.json CSP — letterheads origins', () => {
  const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf-8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }
  const csp =
    vercel.headers.flatMap((h) => h.headers).find((header) => header['key'] === 'Content-Security-Policy')?.value ?? ''
  const directive = (name: string): string =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? ''

  it('script-src allows the letterheads remote; connect-src the remote and letterhead-api', () => {
    expect(directive('script-src')).toContain('https://letterheads.operai.welld.io')
    expect(directive('connect-src')).toContain('https://letterheads.operai.welld.io')
    expect(directive('connect-src')).toContain('https://letterhead-api.operai.welld.io')
  })

  it("remotes.d.ts declares 'letterheads/App'", () => {
    expect(remotesDtsSource).toContain("declare module 'letterheads/App'")
  })

  it('runtime-config.example.json lists the letterheads remote entry', () => {
    const example = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../public/runtime-config.example.json'), 'utf-8'),
    ) as Record<string, string>
    expect(example['letterheads']).toBe('https://letterheads.operai.welld.io/remoteEntry.js')
  })
})

// specs/20261119-accounting: the shell's CSP lets the page load the Accounting remote and reach accounting-api.
describe('vercel.json CSP — accounting origins', () => {
  const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf-8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }
  const csp =
    vercel.headers.flatMap((h) => h.headers).find((header) => header['key'] === 'Content-Security-Policy')?.value ?? ''
  const directive = (name: string): string =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? ''

  it('script-src allows the accounting remote; connect-src the remote and accounting-api', () => {
    expect(directive('script-src')).toContain('https://accounting.operai.welld.io')
    expect(directive('connect-src')).toContain('https://accounting.operai.welld.io')
    expect(directive('connect-src')).toContain('https://accounting-api.operai.welld.io')
  })

  it('opens no other directive to the accounting origins (the remote is a script, the api is a connection)', () => {
    expect(directive('script-src')).not.toContain('accounting-api')
    for (const name of ['default-src', 'style-src', 'font-src', 'img-src', 'media-src', 'frame-ancestors']) {
      expect(directive(name)).not.toContain('accounting')
    }
  })

  it("remotes.d.ts declares 'accounting/App'", () => {
    expect(remotesDtsSource).toContain("declare module 'accounting/App'")
  })

  it('runtime-config.example.json lists the accounting remote entry', () => {
    const example = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../public/runtime-config.example.json'), 'utf-8'),
    ) as Record<string, string>
    expect(example['accounting']).toBe('https://accounting.operai.welld.io/remoteEntry.js')
  })

  it("the shell's dev default for the remote is accounting-ui's pinned port (5183)", () => {
    expect(shellViteConfigSource).toContain("'http://localhost:5183/remoteEntry.js'")
  })
})

// specs/20261112-time-tracking (ADR 20261112-hours-ui-ungated-remote, T23): the shell's CSP lets the page load the Hours remote and reach
// hours-api. Hostnames follow the suite's `<name>[-api].operai.welld.io` scheme, as assumed for specs/20261103-projects
// (`infra/provision-tool.sh hours` is what creates them, T33).
describe('vercel.json CSP — hours origins', () => {
  const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf-8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }
  const csp =
    vercel.headers.flatMap((h) => h.headers).find((header) => header['key'] === 'Content-Security-Policy')?.value ?? ''
  const directive = (name: string): string =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? ''
  const sources = (name: string): string[] => directive(name).split(/\s+/).slice(1)

  it('script-src allows the hours remote', () => {
    expect(sources('script-src')).toContain('https://hours.operai.welld.io')
  })

  it('connect-src allows the hours remote and hours-api', () => {
    expect(sources('connect-src')).toContain('https://hours.operai.welld.io')
    expect(sources('connect-src')).toContain('https://hours-api.operai.welld.io')
  })

  it('names exactly those two origins: no wildcard and no other hours host (the CSP stays an allowlist)', () => {
    const hoursSources = [...sources('script-src'), ...sources('connect-src')].filter((s) => /hours/.test(s))
    expect(new Set(hoursSources)).toEqual(
      new Set(['https://hours.operai.welld.io', 'https://hours-api.operai.welld.io']),
    )
  })

  it("remotes.d.ts declares both of the remote's modules, 'hours/App' and 'hours/version'", () => {
    expect(remotesDtsSource).toContain("declare module 'hours/App'")
    expect(remotesDtsSource).toContain("declare module 'hours/version'")
  })

  // specs/20261116-record-hours-in-place, T3 (ADR 20261116-record-hours-widget-through-the-host-extension-seam): the hours
  // remote's second entry, the Record hours button the hosts embed through `hours.recordHours`. Three things must agree
  // on the specifier: the ambient declaration, the loader in lib/extensions.tsx, and (T2) hours-ui's `exposes`.
  it("remotes.d.ts declares 'hours/RecordHours' with the six string props of the hours.recordHours extension", () => {
    expect(remotesDtsSource).toContain("declare module 'hours/RecordHours'")
    const declaration = /declare module 'hours\/RecordHours' \{[\s\S]*?\n\}/.exec(remotesDtsSource)?.[0] ?? ''
    for (const member of ['on', 'targetId', 'targetName', 'activityId', 'activityName', 'placement']) {
      expect(declaration, `the declaration names '${member}'`).toMatch(new RegExp(`\\b${member}:\\s`))
    }
  })

  it("the shell's hours.recordHours loader imports the specifier remotes.d.ts declares", () => {
    const extensionsSource = readFileSync(path.resolve(__dirname, '../lib/extensions.tsx'), 'utf-8')
    expect(extensionsSource).toMatch(/'hours\.recordHours':\s*\(\)\s*=>\s*import\('hours\/RecordHours'\)/)
  })

  // specs/20261112-project-hours, T14 (plan D-P4): the hours remote's third entry, the read panel of a record's hours the
  // project page and the deal page embed through `hours.hostHours`. The same three things agree on the specifier: the
  // ambient declaration, the loader in lib/extensions.tsx, and (T13) hours-ui's `exposes`.
  it("remotes.d.ts declares 'hours/HostHours' with the two string props of the hours.hostHours extension", () => {
    expect(remotesDtsSource).toContain("declare module 'hours/HostHours'")
    const declaration = /declare module 'hours\/HostHours' \{[\s\S]*?\n\}/.exec(remotesDtsSource)?.[0] ?? ''
    expect(declaration).toMatch(/\bon:\s*'project' \| 'deal'/)
    expect(declaration).toMatch(/\btargetId:\s*string/)
  })

  it("the shell's hours.hostHours loader imports the specifier remotes.d.ts declares", () => {
    const extensionsSource = readFileSync(path.resolve(__dirname, '../lib/extensions.tsx'), 'utf-8')
    expect(extensionsSource).toMatch(/'hours\.hostHours':\s*\(\)\s*=>\s*import\('hours\/HostHours'\)/)
  })

  it("index.css scans hours-ui's source (@source), so the shell's one Tailwind sheet carries the remote's utilities (ADR 20260709-suite-frontend-module-federation addendum)", () => {
    const indexCss = readFileSync(path.resolve(__dirname, '../index.css'), 'utf-8')
    expect(indexCss).toContain('@source "../../hours-ui/src";')
  })

  it('runtime-config.example.json lists the hours remote entry', () => {
    const example = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../public/runtime-config.example.json'), 'utf-8'),
    ) as Record<string, string>
    expect(example['hours']).toBe('https://hours.operai.welld.io/remoteEntry.js')
  })

  it("agrees with hours-ui's own federation config: remote name 'hours', ./App and ./version exposed", () => {
    const hoursViteConfig = readFileSync(path.resolve(__dirname, '../../../hours-ui/vite.config.ts'), 'utf-8')
    expect(hoursViteConfig).toMatch(/federation\(\{\s*name:\s*'hours'/s)
    expect(hoursViteConfig).toMatch(/exposes:\s*\{[^}]*'\.\/App':\s*'\.\/src\/App\.tsx'/s)
    expect(hoursViteConfig).toMatch(/exposes:\s*\{[^}]*'\.\/version':\s*'\.\/src\/version\.ts'/s)
  })

  it("the shell's remote for hours points at the dev port hours-ui pins (5184), overridable by HOURS_REMOTE_URL", () => {
    const hoursViteConfig = readFileSync(path.resolve(__dirname, '../../../hours-ui/vite.config.ts'), 'utf-8')
    expect(hoursViteConfig).toMatch(/port:\s*5184/)
    expect(shellViteConfigSource).toContain("process.env['HOURS_REMOTE_URL'] ?? 'http://localhost:5184/remoteEntry.js'")
  })
})
