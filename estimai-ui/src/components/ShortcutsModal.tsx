import { useEffect } from 'react'

interface Props {
  onClose: () => void
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.6rem] px-1.5 py-0.5 rounded border border-rule bg-ink-mid font-mono text-[10px] text-text leading-none">
      {children}
    </kbd>
  )
}

function Row({ keys, label }: { keys: React.ReactNode[]; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1 w-40 shrink-0 flex-wrap">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted text-[10px]">/</span>}
            <Kbd>{k}</Kbd>
          </span>
        ))}
      </div>
      <span className="text-[12px] text-soft">{label}</span>
    </div>
  )
}

export default function ShortcutsModal({ onClose }: Props) {
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
        className="bg-ink-soft border border-rule rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-disp text-sm font-bold text-text">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-text text-lg leading-none transition-colors"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <section>
            <p className="text-[9px] font-mono uppercase tracking-widest text-muted mb-2">Grid navigation</p>
            <div className="flex flex-col gap-2">
              <Row keys={['Tab', '⇧ Tab']} label="Next / prev cell" />
              <Row keys={['Enter', '↓']} label="Move down one row" />
              <Row keys={['↑']} label="Move up one row" />
              <Row keys={['→', '←']} label="Move right / left (number & select always; text at edge)" />
            </div>
          </section>

          <div className="border-t border-rule" />

          <section>
            <p className="text-[9px] font-mono uppercase tracking-widest text-muted mb-2">Release filter</p>
            <div className="flex flex-col gap-2">
              <Row keys={['⇧ →']} label="Next release" />
              <Row keys={['⇧ ←']} label="Previous release" />
              <Row keys={['⇧ 0']} label="Show all releases" />
            </div>
          </section>

          <div className="border-t border-rule" />

          <section>
            <p className="text-[9px] font-mono uppercase tracking-widest text-muted mb-2">General</p>
            <div className="flex flex-col gap-2">
              <Row keys={['⇧ ?']} label="Toggle this shortcuts panel" />
              <Row keys={['⇧ H']} label="Toggle health warnings" />
              <Row keys={['⇧ Q']} label="Show QR code for sharing" />
              <Row keys={['⇧ N']} label="Create new activity" />
              <Row keys={['Esc']} label="Close panel" />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
