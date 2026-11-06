/**
 * Static contract on `shell/vercel.json` (specs/021-meetings T52): the shell's document governs the
 * CSP of every federated remote (ADR-0006), so the meetings remote, meetings-api and the audio
 * bucket must be named here or the browser refuses them with no server-side trace. Also pins the
 * Permissions-Policy that lets the recorder ask for the microphone and screen audio (AC-2.2, AC-2.4)
 * and keeps the camera off (AC-6.5).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface Header {
  key: string
  value: string
}
interface Rule {
  source: string
  headers: Header[]
}

const config = JSON.parse(readFileSync(path.resolve(__dirname, '../vercel.json'), 'utf8')) as {
  headers: Rule[]
}

function headerOnCatchAll(name: string): string {
  const rule = config.headers.find(
    (r) => r.source === '/(.*)' && r.headers.some((h) => h.key === name),
  )
  const value = rule?.headers.find((h) => h.key === name)?.value
  if (value === undefined) throw new Error(`no ${name} header on the catch-all rule`)
  return value
}

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) map.set(name, sources)
  }
  return map
}

const csp = directives(headerOnCatchAll('Content-Security-Policy'))

describe('shell/vercel.json — meetings (specs/021 T52)', () => {
  it('loads the meetings remote as a script', () => {
    expect(csp.get('script-src')).toContain('https://meetings.operai.welld.io')
  })

  it('lets the shell document call the meetings remote, meetings-api and the audio bucket', () => {
    const connect = csp.get('connect-src')
    expect(connect).toContain('https://meetings.operai.welld.io')
    expect(connect).toContain('https://meetings-api.operai.welld.io')
    expect(connect).toContain('https://t3.storageapi.dev')
  })

  it('allows audio playback from the bucket and blob: object URLs only, with no blanket media source', () => {
    // blob: is for the upload card's duration pre-check (URL.createObjectURL -> loadedmetadata, T66)
    expect(csp.get('media-src')).toEqual(["'self'", 'https://t3.storageapi.dev', 'blob:'])
  })

  it('does not widen any other directive to blob:', () => {
    for (const [name, sources] of csp) {
      if (name !== 'media-src') expect(sources, name).not.toContain('blob:')
    }
  })

  it('keeps the existing hardening directives', () => {
    expect(csp.get('default-src')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'")
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'")
  })

  it('grants microphone and display-capture to the shell origin only and denies the camera', () => {
    expect(headerOnCatchAll('Permissions-Policy')).toBe(
      'microphone=(self), display-capture=(self), camera=()',
    )
  })
})
