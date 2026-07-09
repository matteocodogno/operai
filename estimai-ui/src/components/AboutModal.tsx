import { useEffect } from 'react'
import {
  APP_NAME,
  APP_SUITE,
  APP_DESCRIPTION,
  APP_TAGLINE,
  APP_AUTHOR,
  APP_AUTHOR_URL,
  APP_VERSION,
} from '../lib/appInfo'

interface Props {
  onClose: () => void
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-rule/50 last:border-0">
      <span className="text-[9px] font-mono uppercase tracking-widest text-muted shrink-0">{label}</span>
      <span className="text-[12px] text-text text-right">{children}</span>
    </div>
  )
}

export default function AboutModal({ onClose }: Props) {
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
            <img src="/estimai.svg" alt={APP_NAME} className="h-9 w-9 rounded-md shrink-0" />
            <div>
              <h2 className="font-disp text-sm font-bold text-text leading-none">{APP_NAME}</h2>
              <p className="text-[10px] text-muted mt-1">Part of the {APP_SUITE} suite</p>
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
      </div>
    </div>
  )
}
