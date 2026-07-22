#!/usr/bin/env node
/**
 * `mise run release:tag` — create git tags for a release that has already been
 * versioned + committed (via `mise run release:version`). Does NOT push;
 * review, then `git push --follow-tags`.
 *
 *   - Per-app tags (`@operai/refund-ui@0.1.0`, …) — created by `changeset tag`
 *     (private apps included via `.changeset/config.json` privatePackages.tag).
 *   - Umbrella tag (`operai@a.b.c`) — the root isn't a Changesets package, so
 *     we tag it here ourselves.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

execSync('pnpm exec changeset tag', { stdio: 'inherit' })

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = `operai@${version}`
try {
  execSync(`git rev-parse -q --verify refs/tags/${tag}`, { stdio: 'ignore' })
  console.log(`[operai] tag ${tag} already exists — skipping`)
} catch {
  execSync(`git tag -a ${tag} -m "operai ${version}"`, { stdio: 'inherit' })
  console.log(`[operai] created umbrella tag ${tag}`)
}

console.log('\n[operai] Push the release tags with:  git push --follow-tags')
