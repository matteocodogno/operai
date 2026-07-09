import type { ChangeEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import UserMenu from './UserMenu'
import type { SaveStatus } from '../context/EstimatorContext'

type HeaderUser = {
  name?: string | null
  email?: string | null
  image?: string | null
}

type HeaderProps = {
  name: string
  saveStatus: SaveStatus
  onNameChange: (name: string) => void
  user?: HeaderUser
  onSignOut?: () => void
}

export default function Header({ name, saveStatus, onNameChange, user, onSignOut }: HeaderProps) {
  const navigate = useNavigate()

  return (
    <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
      {/* Desktop */}
      <div className="hidden sm:flex items-center h-14">
        {/* Left — logo */}
        <img src="/estimai.svg" alt="EstimAI" className="h-8 w-8 rounded-md shrink-0" />

        {/* Center — project name */}
        <div className="flex-1 flex items-center justify-center">
          <input
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
            placeholder="Project name…"
            className="w-64 bg-transparent border-0 border-b border-rule rounded-none text-[14px] py-4 px-0 text-center focus:outline-none focus:shadow-none focus:border-acc"
          />
        </div>

        {/* Right — save indicator + list navigation + user menu */}
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
          {user && onSignOut && (
            <UserMenu user={user} onSignOut={onSignOut} />
          )}
        </div>
      </div>

      {/* Mobile */}
      <div className="flex sm:hidden items-center gap-3 h-12">
        <img src="/estimai.svg" alt="EstimAI" className="h-7 w-7 rounded-md shrink-0" />

        <input
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
          placeholder="Project name…"
          className="flex-1 bg-transparent border-0 border-b border-rule rounded-none text-[13px] py-3 px-0 min-w-0 focus:outline-none focus:shadow-none focus:border-acc"
        />

        <button
          onClick={() => navigate({ to: '/estimates' })}
          className="text-muted w-9 h-9 shrink-0 flex items-center justify-center border border-rule hover:text-text transition-colors"
          aria-label="My Estimates"
        >
          ☰
        </button>
        {user && onSignOut && (
          <UserMenu user={user} onSignOut={onSignOut} />
        )}
      </div>
    </header>
  )
}
