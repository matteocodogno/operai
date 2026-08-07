import type { ChangeEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SaveStatus } from '../context/EstimatorContext'

type HeaderProps = {
  name: string
  saveStatus: SaveStatus
  onNameChange: (name: string) => void
  /**
   * T17 (specs/013-estimate-sharing/tasks.md; design.md S5): fed from
   * context's single `canEdit` gate (`!canEdit`). Defaults to `false` so
   * every pre-existing call site keeps its exact prior full-edit behaviour.
   * The name input becomes `readOnly` (not `disabled`); the save-status
   * span is omitted entirely — nothing ever autosaves for a viewer, so
   * there is nothing to report (not shown blank).
   */
  readOnly?: boolean
}

export default function Header({ name, saveStatus, onNameChange, readOnly = false }: HeaderProps) {
  const navigate = useNavigate()

  return (
    <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
      {/* Single desktop-only row. estimai-ui runs inside the desktop-only suite
          shell (specs/003), so there is no separate mobile header — one row is
          all this chrome needs. (Responsive variant utilities now behave
          correctly in-shell too: the suite runs a single shell-owned Tailwind
          sheet, so the old cross-sheet `sm:*` cascade is gone — see
          docs/adr/0006 Remote CSS strategy addendum.) */}
      <div className="flex items-center h-14">
        {/* Center — project name */}
        <div className="flex-1 flex items-center justify-center">
          <input
            value={name}
            readOnly={readOnly}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
            placeholder="Project name…"
            className="w-64 bg-transparent border-0 border-b border-rule rounded-none text-[14px] py-4 px-0 text-center focus:outline-none focus:shadow-none focus:border-acc"
          />
        </div>

        {/* Right — save indicator + list navigation */}
        <div className="flex items-center justify-end gap-3 shrink-0">
          {/* T17 (design.md S5): nothing ever autosaves for a viewer, so the
              save-status indicator is omitted entirely — not shown blank. */}
          {!readOnly && (
            <span
              className={`text-[11px] font-mono transition-opacity duration-500 ${
                saveStatus === 'saved'
                  ? 'text-grn'
                  : saveStatus === 'saving'
                    ? 'text-soft'
                    : saveStatus === 'error'
                      ? 'text-org'
                      : 'text-grn'
              }`}
              style={{ opacity: saveStatus === 'idle' ? 0 : 1 }}
              aria-live="polite"
            >
              {saveStatus === 'saving'
                ? 'Saving…'
                : saveStatus === 'error'
                  ? 'Save failed'
                  : '✓ Saved'}
            </span>
          )}
          <button
            onClick={() => navigate({ to: '/estimates' })}
            className="text-muted text-sm py-1 px-2.5 border border-rule hover:text-text transition-colors"
            title="My Estimates"
          >
            ☰ My Estimates
          </button>
        </div>
      </div>
    </header>
  )
}
