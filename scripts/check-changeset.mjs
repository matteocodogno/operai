#!/usr/bin/env node
/**
 * scripts/check-changeset.mjs — does this diff add a changeset alongside any
 * app-code change under a Changesets-tracked package dir?
 *
 * NOT implemented via `changeset status`'s exit code: verified live in this
 * repo that `pnpm exec changeset status` (with or without `--since`) always
 * exits 0, pending changesets or not — it's an informational command, not a
 * gate primitive. This does a direct two-way `git diff` instead.
 *
 * Usage:
 *   node scripts/check-changeset.mjs --base=<sha> --head=<sha>
 *     Explicit mode — local dry runs, unit-testable against any two commits.
 *
 *   node scripts/check-changeset.mjs
 *     CI mode — resolves base/head from the GitHub Actions event, via env
 *     vars set by .github/workflows/changeset-check.yml:
 *       GH_EVENT_NAME   github.event_name          ("pull_request" | "push" | ...)
 *       GH_BASE_SHA     github.event.pull_request.base.sha   (pull_request only)
 *       GH_BEFORE_SHA   github.event.before                  (push only)
 *       GH_HEAD_SHA     github.sha
 *
 * Exit codes: 0 = OK (or gate skipped — see the ::warning:: cases below),
 * 1 = app code changed with no changeset, 2 = usage error (can't resolve refs).
 */
import { execFileSync } from 'node:child_process'

// The 9 lerna.json package dirs — the exact, un-driftable set of
// Changesets-tracked apps. An allowlist, not a denylist of docs/specs/etc.,
// so it can never fall out of sync with a new non-code top-level directory.
const APP_DIRS = [
  'auth',
  'estimai-api',
  'notify-api',
  'refund-api',
  'shell',
  'estimai-ui',
  'refund-ui',
  'notify-ui',
  'admin-ui',
]

const ALL_ZERO_SHA = '0000000000000000000000000000000000000000'

function arg(name) {
  const prefix = `--${name}=`
  const found = process.argv.find((a) => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : undefined
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

/** Resolve {base, head} SHAs to diff, or exit (0 = skip gate, 2 = usage error). */
function resolveRefs() {
  const argBase = arg('base')
  const argHead = arg('head')
  if (argBase && argHead) return { base: argBase, head: argHead }
  if (argBase || argHead) {
    console.error('usage: node scripts/check-changeset.mjs --base=<sha> --head=<sha> (both or neither)')
    process.exit(2)
  }

  const eventName = process.env.GH_EVENT_NAME
  const headSha = process.env.GH_HEAD_SHA
  if (!headSha) {
    console.error(
      'usage: node scripts/check-changeset.mjs --base=<sha> --head=<sha>\n' +
        '   or: set GH_HEAD_SHA (+ GH_EVENT_NAME + GH_BASE_SHA/GH_BEFORE_SHA) for CI mode',
    )
    process.exit(2)
  }

  if (eventName === 'pull_request') {
    const baseSha = process.env.GH_BASE_SHA
    if (!baseSha) {
      console.error('usage: pull_request event but GH_BASE_SHA is unset.')
      process.exit(2)
    }
    return { base: baseSha, head: headSha }
  }

  // push — and any other/unrecognized event (e.g. workflow_dispatch, which
  // has no natural "before" either) — falls back to the same before/HEAD~1
  // logic.
  const beforeSha = process.env.GH_BEFORE_SHA
  if (beforeSha && beforeSha !== ALL_ZERO_SHA) {
    return { base: beforeSha, head: headSha }
  }

  // `before` is the all-zero SHA (new branch / force-push with no common
  // history) or simply unset (e.g. workflow_dispatch). No real diff baseline
  // exists from the event alone — fall back to HEAD~1 if it resolves in this
  // checkout; otherwise this is a known, documented limitation: skip the
  // gate for this run rather than silently swallow it or hard-fail a push
  // that can't be un-landed anyway.
  try {
    const parent = git(['rev-parse', `${headSha}~1`])
    console.log(
      `::warning::GH_BEFORE_SHA is unset/all-zero — falling back to ${parent} (HEAD~1) as the diff baseline.`,
    )
    return { base: parent, head: headSha }
  } catch {
    console.log('::warning::cannot establish a diff baseline for this push — changeset gate skipped for this run.')
    process.exit(0)
  }
}

const { base, head } = resolveRefs()

let changedFiles
try {
  changedFiles = git(['diff', '--name-only', base, head]).split('\n').filter(Boolean)
} catch (err) {
  const reason = String(err.message).split('\n')[0]
  console.log(`::warning::cannot diff ${base}..${head} (${reason}) — changeset gate skipped for this run.`)
  process.exit(0)
}

const changedAppDirs = new Set(changedFiles.map((f) => f.split('/')[0]).filter((dir) => APP_DIRS.includes(dir)))

if (changedAppDirs.size === 0) {
  console.log('[check-changeset] No app-code changes under the tracked package dirs — nothing to gate.')
  process.exit(0)
}

const addedChangesets = git(['diff', '--name-only', '--diff-filter=A', base, head])
  .split('\n')
  .filter(Boolean)
  .filter((f) => f.startsWith('.changeset/') && f.endsWith('.md') && f !== '.changeset/README.md')

if (addedChangesets.length === 0) {
  const dirs = [...changedAppDirs].sort().join(', ')
  console.error(
    `::error::App code changed under ${dirs} without an accompanying changeset. Run \`mise run changeset\` ` +
      '(pick the affected package(s) + patch/minor/major + a one-line summary) and commit the resulting ' +
      '.changeset/*.md file with this change. If this is deliberately a no-release change (docs-only inside ' +
      'an app dir, CI/tooling-only, etc.), run `pnpm exec changeset add --empty` instead — ' +
      "Changesets' own convention for an intentional no-op release note — and commit that file.",
  )
  process.exit(1)
}

console.log(
  `[check-changeset] OK — app code changed under ${[...changedAppDirs].sort().join(', ')}, ` +
    `matched changeset(s): ${addedChangesets.join(', ')}`,
)
process.exit(0)
