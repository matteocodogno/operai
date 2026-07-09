/**
 * LogoMenu — the app logo as a dropdown trigger in the header.
 *
 * Clicking the logo opens a small menu; its "About" item calls onAbout (the
 * parent owns the About modal). Closes on click-outside and Escape, mirroring
 * UserMenu.
 */

import { useEffect, useRef, useState } from 'react'
import { APP_NAME } from '../lib/appInfo'

interface Props {
  onAbout: () => void
  /** Tailwind size classes for the logo image (defaults to the desktop size). */
  imgClassName?: string
}

export default function LogoMenu({ onAbout, imgClassName = 'h-8 w-8' }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-acc/50"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${APP_NAME} menu`}
      >
        <img src="/estimai.svg" alt={APP_NAME} className={`${imgClassName} rounded-md`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 mt-2 min-w-[160px] bg-ink-soft border border-rule rounded-lg shadow-2xl z-50 py-1"
        >
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onAbout()
            }}
            className="w-full text-left text-[12px] text-soft hover:text-text hover:bg-ink-mid px-3 py-2 transition-colors"
          >
            About {APP_NAME}
          </button>
        </div>
      )}
    </div>
  )
}
