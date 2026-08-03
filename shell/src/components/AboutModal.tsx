/**
 * AboutModal — the About dialog, describing the Operai suite itself.
 *
 * Relocated from estimai-ui/src/components/AboutModal.tsx (T6, specs/003-suite-shell,
 * AC-1.4) — structurally unchanged. Content is sourced from the relocated,
 * suite-level ../lib/appInfo (name/description/version = Operai the suite, not a single
 * tool). The EstimAI original's "Part of the {APP_SUITE} suite" subtitle is dropped here
 * — this dialog no longer describes a tool that's *part of* a suite, it describes the
 * suite itself, so that framing no longer applies.
 *
 * "Version" above shows the umbrella suite version (APP_VERSION). Below it, a
 * "Components" section additionally lists each mounted remote's OWN version
 * (../hooks/useRemoteVersions) — see that module's doc for the resolution/
 * degradation contract. Every row renders independently and immediately: a
 * remote whose version can't be resolved (unreachable, cold-starting, timed
 * out, or predating this feature and missing `./version` entirely) shows a
 * muted "—" rather than blocking the dialog or throwing.
 */
import { useEffect } from 'react'
import {
  APP_NAME,
  APP_DESCRIPTION,
  APP_TAGLINE,
  APP_AUTHOR,
  APP_AUTHOR_URL,
  APP_VERSION,
} from '../lib/appInfo'
import {
  REMOTE_VERSION_SOURCES,
  useRemoteVersions,
  type RemoteVersionSource,
} from '../hooks/useRemoteVersions'

interface Props {
  onClose: () => void
  /**
   * Test-only injection seam, defaulting to the real suite remotes. Lets
   * AboutModal.test.tsx exercise each of a remote's `./version` import's
   * failure shapes (rejection, timeout, malformed export) with plain,
   * directly-controllable loader functions instead of mocking Module
   * Federation's bare import specifiers — the same shape RemoteMount's
   * `loader` prop already establishes in this codebase for testing async
   * remote-loading states deterministically.
   */
  remoteVersionSources?: readonly RemoteVersionSource[]
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-rule/50 last:border-0">
      <span className="text-[9px] font-mono uppercase tracking-widest text-muted shrink-0">{label}</span>
      <span className="text-[12px] text-text text-right">{children}</span>
    </div>
  )
}

export default function AboutModal({ onClose, remoteVersionSources = REMOTE_VERSION_SOURCES }: Props) {
  const remoteVersions = useRemoteVersions(remoteVersionSources)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`About ${APP_NAME}`}
        className="bg-ink-soft border border-rule rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <img src="/operai.svg" alt={APP_NAME} className="h-9 w-9 rounded-md shrink-0" />
            <div>
              <h2 className="font-disp text-sm font-bold text-text leading-none">{APP_NAME}</h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text text-lg leading-none transition-colors"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <p className="text-[12px] text-soft leading-relaxed mb-1">{APP_DESCRIPTION}</p>
        <p className="text-[11px] text-muted italic mb-4">{APP_TAGLINE}</p>

        <div className="flex flex-col">
          <InfoRow label="Version">
            <span className="font-mono">{APP_VERSION}</span>
          </InfoRow>
          <InfoRow label="Author">
            <a
              href={APP_AUTHOR_URL}
              target="_blank"
              rel="noreferrer"
              className="text-acc hover:text-acc-hi underline underline-offset-2"
            >
              {APP_AUTHOR}
            </a>
          </InfoRow>
        </div>

        <div className="flex flex-col mt-3 pt-3 border-t border-rule/50">
          <p className="text-[9px] font-mono uppercase tracking-widest text-muted mb-1.5">
            Components
          </p>
          {remoteVersionSources.map(source => {
            const version = remoteVersions[source.id]
            return (
              <InfoRow key={source.id} label={source.label}>
                <span
                  data-testid={`remote-version-${source.id}`}
                  className={version ? 'font-mono' : 'font-mono text-dim'}
                >
                  {version ?? '—'}
                </span>
              </InfoRow>
            )
          })}
        </div>
      </div>
    </div>
  )
}
