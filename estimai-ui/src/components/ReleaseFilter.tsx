import type { Release } from '../types'

interface Props {
  releases: Release[]
  activeRelease: string | null
  onSelect: (name: string | null) => void
}

export default function ReleaseFilter({ releases, activeRelease, onSelect }: Props) {
  if (releases.length === 0) return null

  return (
    <div className="flex items-center gap-1.5 mb-3 flex-wrap">
      <span className="text-[10px] font-mono uppercase tracking-widest text-muted mr-0.5">Filter</span>
      <button
        onClick={() => onSelect(null)}
        aria-pressed={activeRelease === null}
        className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc ${
          activeRelease === null
            ? 'bg-acc text-white border-acc'
            : 'bg-transparent text-muted border-rule hover:border-acc/50 hover:text-soft'
        }`}
      >
        All
      </button>
      {releases.map(r => (
        <button
          key={r.id}
          onClick={() => onSelect(r.name)}
          title={r.name}
          aria-pressed={activeRelease === r.name}
          className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors border max-w-50 truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc ${
            activeRelease === r.name
              ? 'bg-acc text-white border-acc'
              : 'bg-transparent text-muted border-rule hover:border-acc/50 hover:text-soft'
          }`}
        >
          {r.name}
        </button>
      ))}
    </div>
  )
}
