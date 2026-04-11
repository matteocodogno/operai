/**
 * Build a sanitized export filename.
 * releaseName is included when a release filter is active.
 *
 * Examples:
 *   buildExportFilename('Acme App')            → 'Acme_App_estimate'
 *   buildExportFilename('Acme App', 'v1.0/beta') → 'Acme_App_v1.0_beta_estimate'
 */
export function buildExportFilename(projectName: string, releaseName?: string): string {
  const sanitize = (s: string) =>
    s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')

  const base = sanitize(projectName) || 'estimate'
  if (releaseName) {
    const rel = sanitize(releaseName)
    return rel ? `${base}_${rel}_estimate` : `${base}_estimate`
  }
  return `${base}_estimate`
}
