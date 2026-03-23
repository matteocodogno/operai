import LZString from 'lz-string'
import type { ProjectData } from './projects'

export function encodeEstimate(data: ProjectData): string {
  return LZString.compressToEncodedURIComponent(JSON.stringify(data))
}

export function decodeEstimate(encoded: string): ProjectData | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(encoded)
    if (!json) return null
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed.acts) || !Array.isArray(parsed.releases) || typeof parsed.params !== 'object') {
      return null
    }
    return parsed as ProjectData
  } catch {
    return null
  }
}

export function buildShareUrl(data: ProjectData): string {
  return `${window.location.origin}/share#data=${encodeEstimate(data)}`
}

export function getHashData(): string | null {
  const hash = window.location.hash
  const match = hash.match(/^#data=(.+)/)
  return match ? match[1] : null
}
