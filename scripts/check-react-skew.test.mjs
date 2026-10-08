// node --test scripts/check-react-skew.test.mjs  (no dependencies)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkReactSkew, readReactVersions } from './check-react-skew.mjs'

const lock = (react, dom = react, extra = '') => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      react:
        specifier: ^19.2.4
        version: ${react}

packages:

  react-dom@${dom}:
    resolution: {integrity: sha512-x}

  react@${react}:
    resolution: {integrity: sha512-y}
${extra}
snapshots:

  react@${react}: {}
`

function tree(apps) {
  const root = mkdtempSync(join(tmpdir(), 'react-skew-'))
  writeFileSync(join(root, 'lerna.json'), JSON.stringify({ packages: [...Object.keys(apps), 'some-api'] }))
  for (const [dir, text] of Object.entries(apps)) {
    mkdirSync(join(root, dir))
    writeFileSync(join(root, dir, 'pnpm-lock.yaml'), text)
  }
  mkdirSync(join(root, 'some-api')) // a backend: no pnpm-lock.yaml, ignored
  return root
}

test('reads only the packages section', () => {
  const v = readReactVersions(lock('19.2.7'))
  assert.deepEqual([...v.react], ['19.2.7'])
  assert.deepEqual([...v['react-dom']], ['19.2.7'])
})

test('passes when every frontend resolves the same version', () => {
  const root = tree({ shell: lock('19.2.7'), 'a-ui': lock('19.2.7') })
  try { assert.deepEqual(checkReactSkew(root).problems, []) } finally { rmSync(root, { recursive: true }) }
})

test('fails when one frontend resolves a different version', () => {
  const root = tree({ shell: lock('19.2.7'), 'a-ui': lock('19.2.7'), 'b-ui': lock('19.3.0') })
  try {
    const { problems } = checkReactSkew(root)
    assert.ok(problems.some((p) => p.includes('react versions differ') && p.includes('b-ui')), problems.join('\n'))
  } finally { rmSync(root, { recursive: true }) }
})

test('fails on two copies of react inside one lockfile', () => {
  const root = tree({ shell: lock('19.2.7'), 'a-ui': lock('19.2.7', '19.2.7', '  react@19.3.0:\n    resolution: {integrity: sha512-z}\n') })
  try { assert.ok(checkReactSkew(root).problems.some((p) => p.includes('a-ui') && p.includes('AND'))) } finally { rmSync(root, { recursive: true }) }
})

test('fails (never silently passes) when a lockfile has no react entry', () => {
  const root = tree({ shell: lock('19.2.7'), 'a-ui': "lockfileVersion: '9.0'\n\npackages:\n\n  left-pad@1.0.0:\n    resolution: {}\n" })
  try { assert.ok(checkReactSkew(root).problems.some((p) => p.includes('a-ui') && p.includes('no react'))) } finally { rmSync(root, { recursive: true }) }
})

test('fails when react and react-dom disagree', () => {
  const root = tree({ shell: lock('19.2.7', '19.2.4'), 'a-ui': lock('19.2.7', '19.2.4') })
  try { assert.ok(checkReactSkew(root).problems.some((p) => p.includes('react 19.2.7 and react-dom 19.2.4'))) } finally { rmSync(root, { recursive: true }) }
})
