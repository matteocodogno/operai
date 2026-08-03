/**
 * Real-artifact coverage for the ADR-0030 `./version` federated export
 * (QE finding on the version-bump feature, chore/version-release-enforcement).
 *
 * ../hooks/useRemoteVersions.test's four failure-shape cases (see
 * AboutModal.test.tsx) all inject `remoteVersionSources` with hand-written
 * loader functions — they prove the generic Promise-race/degrade plumbing
 * works, but none of them ever touches a real remote's `exposes` config, a
 * real `src/version.ts`, or a real Module Federation container. A typo'd
 * `exposes: { './version': ... }` key, a wrong module specifier, or a
 * missing `REMOTE_VERSION` export in one of the four remotes would sail
 * through that suite untouched.
 *
 * This file closes that gap the CHEAPEST way that still exercises the REAL
 * production artifact end to end, with no mocking and no running servers:
 *   1. `beforeAll` runs each remote's own `pnpm build` (the exact command
 *      each app's CI/Vercel deploy runs) — the exposes map, `src/version.ts`,
 *      and the `__REMOTE_VERSION__` define all go through the real
 *      `@module-federation/vite` plugin, unmodified.
 *   2. Each test dynamically `import()`s the REAL built `dist/remoteEntry.js`
 *      (a `file://` URL, not a specifier vitest.config.ts's aliases can
 *      intercept) and calls the container's own `get('./version')` — the
 *      exact same MF container method the runtime invokes internally when
 *      the shell does `import('estimai/version')` in the browser.
 *
 * Deliberately SKIPS calling the container's `init()` — that negotiates the
 * shared-singleton scope (react, react-dom, @tanstack/react-router,
 * better-auth) via `@module-federation/runtime`'s SSR-bootstrap path, which
 * assumes a DOM/browser-ish host and is flatly irrelevant to `./version`
 * (src/version.ts imports nothing). `get()` alone is independent of
 * `init()` in the generated container and is exactly what a typo'd exposes
 * key or a missing export breaks — proven by deliberately breaking both
 * (see this branch's PR description / commit history for the red-run
 * transcript): a typo makes `get('./version')` reject with "[Module
 * Federation] Module ./version does not exist in container.", and a missing
 * `REMOTE_VERSION` export makes the resolved module's `.REMOTE_VERSION`
 * come back `undefined`.
 *
 * What this test does NOT cover (see remoteVersionSpecifiers.test.ts for the
 * complementary static check, and the honest residual-risk note in the PR
 * description): the shell's OWN runtime remote-name-to-URL resolution (its
 * `remotes: { estimai: { name: 'estimai', entry: ... } }` config), the
 * cross-origin `remoteEntry.js` fetch, and shared-singleton negotiation —
 * that slice needs a real browser against real running dev servers
 * (shell/e2e's webServer harness) and is deliberately left as residual risk
 * rather than standing up the full backend stack (Postgres, auth w/
 * 1Password-sourced JWT keys, three resource APIs) for this one defect.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface RemoteFixture {
  /** Matches useRemoteVersions.ts's RemoteVersionSource['id']. */
  id: 'estimai' | 'refund' | 'admin' | 'notify'
  /** Directory name, sibling to shell/, per CLAUDE.md's monorepo layout. */
  dirName: string
}

// Mirrors useRemoteVersions.ts's REMOTE_VERSION_SOURCES exactly (also
// cross-checked statically in remoteVersionSpecifiers.test.ts).
const REMOTES: readonly RemoteFixture[] = [
  { id: 'estimai', dirName: 'estimai-ui' },
  { id: 'refund', dirName: 'refund-ui' },
  { id: 'admin', dirName: 'admin-ui' },
  { id: 'notify', dirName: 'notify-ui' },
]

function remoteDir(dirName: string): string {
  return path.resolve(__dirname, '../../../', dirName)
}

// A real `vite build` per remote (~1-2s each) — the whole point is to run
// the ACTUAL build, not a stand-in for it. Generous timeout: cold
// node_modules / a slow CI runner can push this well past vitest's 5s
// default hook timeout.
//
// The env override below (NODE_ENV forced + every VITEST*/TEST var
// stripped) was discovered the hard way while building this test: Vitest
// sets NODE_ENV=test plus VITEST=true/TEST=true/VITEST_WORKER_ID/
// VITEST_POOL_ID/VITEST_MODE on its own process, and `execFileSync`
// otherwise inherits ALL of them into the spawned `pnpm build`. With that
// leaking through, `@module-federation/vite`'s plugin does not activate at
// all — rolldown then fails outright trying to resolve the bare
// `shell/session` remote specifier as if it were a real installed package.
// This is an environment quirk of running a build from inside a test
// runner, unrelated to anything a contributor did — but silently building
// the wrong (non-federated) artifact would have made this whole test
// meaningless, so the child's env is scrubbed explicitly rather than left to
// inherit.
const cleanBuildEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(VITEST|TEST)/.test(key)),
)
cleanBuildEnv['NODE_ENV'] = 'production'

beforeAll(() => {
  for (const remote of REMOTES) {
    const cwd = remoteDir(remote.dirName)
    try {
      execFileSync('pnpm', ['build'], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf-8',
        env: cleanBuildEnv,
      })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string }
      throw new Error(
        `[remoteVersionExposes.integration] \`pnpm build\` failed in ${cwd}. ` +
          `Make sure ${remote.dirName} has its own \`pnpm install\` run (each app in this ` +
          `monorepo installs independently — see CLAUDE.md).\n--- stdout ---\n${e.stdout ?? ''}\n` +
          `--- stderr ---\n${e.stderr ?? ''}`,
        { cause: err },
      )
    }
  }
}, 120_000)

describe.each(REMOTES)('$id remote — real built ./version federation expose', ({ dirName }) => {
  it("the container's get('./version') resolves to this remote's own package.json version, with no mocking", async () => {
    const dir = remoteDir(dirName)
    const remoteEntryPath = path.join(dir, 'dist', 'remoteEntry.js')
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
      version: string
    }

    const container = (await import(pathToFileURL(remoteEntryPath).href)) as {
      get: (moduleName: string) => Promise<() => { REMOTE_VERSION?: unknown }>
    }
    const factory = await container.get('./version')
    const mod = factory()

    expect(typeof mod.REMOTE_VERSION).toBe('string')
    expect(mod.REMOTE_VERSION).toBe(pkg.version)
  })

  it(`the container rejects a module that isn't actually exposed (sanity check: it's a real MF container distinguishing modules, not a stub that resolves anything)`, async () => {
    const dir = remoteDir(dirName)
    const remoteEntryPath = path.join(dir, 'dist', 'remoteEntry.js')
    const container = (await import(pathToFileURL(remoteEntryPath).href)) as {
      get: (moduleName: string) => Promise<() => unknown>
    }
    await expect(container.get('./this-module-does-not-exist')).rejects.toThrow(
      /does not exist in container/,
    )
  })
})
