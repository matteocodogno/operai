#!/usr/bin/env node
/**
 * `mise run release:version` — apply pending changesets, then derive the
 * umbrella `operai` version (Option B: independent per-app SemVer + an
 * aggregate suite version).
 *
 * Steps:
 *   1. Capture the pending release plan BEFORE it's consumed (`changeset
 *      status --output`), so we know the largest bump in this release.
 *   2. `changeset version` — bump each affected app's `package.json` version
 *      + write its own `CHANGELOG.md`, and delete the consumed changesets.
 *   3. Bump the root `operai` version by the LARGEST per-app bump
 *      (major > minor > patch) and prepend a suite-level entry to the root
 *      `CHANGELOG.md`.
 *   4. Write `shell/src/lib/suiteVersion.generated.json` (`{ "version":
 *      "<umbrella>" }`) — the shell build's only source of the umbrella
 *      version. shell/vite.config.ts reads this same-directory (not
 *      `../package.json`: the shell's Vercel Root Directory is `shell/`, and
 *      nothing about that build should require reaching the repo root — see
 *      the version-bump plan's §B). Written unconditionally (created if
 *      absent, not read-modify-write) so this step never depends on the
 *      file's prior state.
 *
 * The root `operai` package is deliberately NOT a Changesets package (it is
 * the workspace root, absent from the `workspaces` globs), so its version is
 * ours to aggregate here rather than something Changesets touches.
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'

// shell/vite.config.ts reads its own umbrella-version copy from here — see
// step 4 below and the version-bump plan's §B (why this isn't `../package.json`).
const SUITE_VERSION_FILE = 'shell/src/lib/suiteVersion.generated.json'

const RANK = { patch: 1, minor: 2, major: 3 }
const NAMES = ['patch', 'minor', 'major']
const dirFor = (name) => name.replace(/^@operai\//, '') // @operai/refund-ui → refund-ui

function pendingReleases() {
  const out = '.changeset/.status.json'
  try {
    execSync(`pnpm exec changeset status --output=${out}`, { stdio: ['inherit', 'ignore', 'inherit'] })
  } catch {
    // `changeset status` may exit non-zero in edge cases; fall through to the file check.
  }
  if (!existsSync(out)) return []
  const releases = (JSON.parse(readFileSync(out, 'utf8')).releases ?? []).filter((r) => r.type && r.type !== 'none')
  rmSync(out, { force: true })
  return releases
}

const releases = pendingReleases()
if (releases.length === 0) {
  console.log('[operai] No pending changesets — nothing to version. (Record one with `mise run changeset`.)')
  process.exit(0)
}

// 2. Per-app version bumps + per-app CHANGELOG.md.
execSync('pnpm exec changeset version', { stdio: 'inherit' })

// 3. Umbrella `operai` version = current + the largest per-app bump this release.
const maxRank = Math.max(...releases.map((r) => RANK[r.type] ?? 0))
const type = NAMES[maxRank - 1]
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [a, b, c] = pkg.version.split('.').map(Number)
pkg.version = type === 'major' ? `${a + 1}.0.0` : type === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)

// 4. Write the shell's in-tree copy of the umbrella version, unconditionally
// (never read-modify-write — this file may not exist yet in a fresh
// checkout). Same write site as the root package.json bump above, so the two
// can never drift apart between releases.
mkdirSync('shell/src/lib', { recursive: true })
writeFileSync(SUITE_VERSION_FILE, `${JSON.stringify({ version: pkg.version }, null, 2)}\n`)

// Suite-level CHANGELOG entry (the umbrella view over this release's apps).
const lines = releases
  .map((r) => {
    const v = JSON.parse(readFileSync(`${dirFor(r.name)}/package.json`, 'utf8')).version
    return `- ${r.name} → ${v} (${r.type})`
  })
  .sort()
const date = new Date().toISOString().slice(0, 10)
const entry = `## operai ${pkg.version} — ${date}\n\n${lines.join('\n')}\n\n`
const TITLE = '# Operai — suite changelog\n\n'
const prev = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : TITLE
const body = prev.startsWith(TITLE) ? prev.slice(TITLE.length) : prev
writeFileSync('CHANGELOG.md', `${TITLE}${entry}${body}`)

console.log(`\n[operai] umbrella version → ${pkg.version} (aggregate ${type}); ${releases.length} app(s) released.`)
console.log(`[operai] wrote ${SUITE_VERSION_FILE} (shell build's umbrella-version source).`)
console.log('[operai] Review the version bumps + CHANGELOGs, commit them, then run `mise run release:tag`.')
