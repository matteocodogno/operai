import type { ChangeEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'

interface HeaderProps {
  name: string
  author: string
  onNameChange: (name: string) => void
  onAuthorChange: (author: string) => void
}

export default function Header({ name, author, onNameChange, onAuthorChange }: HeaderProps) {
  const navigate = useNavigate()

  return (
    <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
      {/* Desktop */}
      <div className="hidden sm:flex items-center h-14">
        {/* Left — logo */}
        <span className="font-disp text-xl font-extrabold shrink-0 bg-[linear-gradient(130deg,#8b96ff,#2ec27e)] bg-clip-text text-transparent">
          EstimAI
        </span>

        {/* Center — project name + author */}
        <div className="flex-1 flex items-center justify-center gap-4">
          <input
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
            placeholder="Project name…"
            className="w-64 bg-transparent border-0 border-b border-rule rounded-none text-[14px] py-4 px-0 text-center"
          />
          <input
            value={author}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onAuthorChange(e.target.value)}
            placeholder="Author"
            className="w-28"
          />
        </div>

        {/* Right — list navigation */}
        <div className="w-40 flex justify-end shrink-0">
          <button
            onClick={() => navigate({ to: '/estimates' })}
            className="text-muted text-sm py-1 px-2.5 border border-rule hover:text-text transition-colors"
            title="My Estimates"
          >
            ☰ My Estimates
          </button>
        </div>
      </div>

      {/* Mobile */}
      <div className="flex sm:hidden items-center gap-3 h-12">
        <span className="font-disp text-xl font-extrabold shrink-0 bg-[linear-gradient(130deg,#8b96ff,#2ec27e)] bg-clip-text text-transparent">
          E
        </span>

        <input
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
          placeholder="Project name…"
          className="flex-1 bg-transparent border-0 border-b border-rule rounded-none text-[13px] py-3 px-0 min-w-0"
        />

        <button
          onClick={() => navigate({ to: '/estimates' })}
          className="text-muted w-9 h-9 shrink-0 flex items-center justify-center border border-rule hover:text-text transition-colors"
          aria-label="My Estimates"
        >
          ☰
        </button>
      </div>
    </header>
  )
}
