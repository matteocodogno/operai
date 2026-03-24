import { TEMPLATES } from '../lib/templates'
import type { Template } from '../lib/templates'

interface Props {
  onSelect: (t: Template) => void
  onBlank: () => void
}

function epicCount(t: Template): number {
  return new Set(t.activities.map(a => a.epic)).size
}

export default function TemplatePicker({ onSelect, onBlank }: Props) {
  return (
    <div className="flex flex-col items-center px-5.5 py-12 gap-8">
      <div className="text-center">
        <p className="text-muted text-sm">Pick a starting point or build from scratch.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl">
        {TEMPLATES.map(t => (
          <button
            key={t.id}
            onClick={() => onSelect(t)}
            className="group text-left flex flex-col gap-3 p-5 border border-rule bg-ink-soft rounded-md
              hover:border-acc/50 hover:bg-ink-mid transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-2xl leading-none">{t.icon}</span>
              <span className="font-medium text-sm text-text">{t.name}</span>
            </div>

            <p className="text-[11.5px] text-muted leading-relaxed flex-1">{t.description}</p>

            <div className="flex items-center gap-3 text-[11px] font-mono text-muted/70">
              <span>{t.activities.length} activities</span>
              <span className="w-px h-3 bg-rule" />
              <span>{epicCount(t)} epics</span>
            </div>

            <span className="text-[11px] font-medium text-acc opacity-0 group-hover:opacity-100 transition-opacity">
              Use template →
            </span>
          </button>
        ))}
      </div>

      <button
        onClick={onBlank}
        className="text-[12px] text-muted hover:text-text transition-colors underline underline-offset-2"
      >
        Start with a blank estimate
      </button>
    </div>
  )
}
