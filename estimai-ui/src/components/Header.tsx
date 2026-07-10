import type { ChangeEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SaveStatus } from '../context/EstimatorContext'

type HeaderProps = {
  name: string
  saveStatus: SaveStatus
  onNameChange: (name: string) => void
}

export default function Header({ name, saveStatus, onNameChange }: HeaderProps) {
  const navigate = useNavigate()

  return (
    <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
      {/* Single desktop-only row. estimai-ui runs inside the desktop-only suite
          shell (specs/003), so there is no separate mobile header — a second
          responsive row here also renders alongside this one, because with the
          shell's + estimai-ui's Tailwind both on the page the cross-sheet
          `sm:hidden` cascade is unreliable. One row avoids that entirely. */}
      <div className="flex items-center h-14">
        {/* Center — project name */}
        <div className="flex-1 flex items-center justify-center">
          <input
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
            placeholder="Project name…"
            className="w-64 bg-transparent border-0 border-b border-rule rounded-none text-[14px] py-4 px-0 text-center focus:outline-none focus:shadow-none focus:border-acc"
          />
        </div>

        {/* Right — save indicator + list navigation */}
        <div className="flex items-center justify-end gap-3 shrink-0">
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
