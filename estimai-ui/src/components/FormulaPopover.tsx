import { useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  text: string;
}

export default function FormulaPopover({ text }: Props) {
  type Anchor = { top: number } & ({ left: number } | { right: number })
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  return (
    <span className="inline-flex items-center ml-1 align-middle">
      <span
        className="text-[9px] text-muted/60 cursor-help select-none hover:text-muted transition-colors"
        onMouseEnter={e => {
          const r = e.currentTarget.getBoundingClientRect()
          const onLeft = r.left < window.innerWidth / 2
          setAnchor(onLeft
            ? { top: r.top, left: r.left }
            : { top: r.top, right: window.innerWidth - r.right }
          )
        }}
        onMouseLeave={() => setAnchor(null)}
      >ⓘ</span>
      {anchor && createPortal(
        <span
          style={{ position: 'fixed', transform: 'translateY(-100%)', ...anchor }}
          className="w-max max-w-72 bg-ink-mid border border-rule text-[10.5px] text-soft font-mono
            leading-relaxed px-2.5 py-1.5 rounded shadow-xl z-9999 whitespace-pre-line pointer-events-none"
        >
          {text}
        </span>,
        document.body
      )}
    </span>
  )
}
