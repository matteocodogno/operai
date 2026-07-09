import { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { type WarningCode, WARNING_META } from "../lib/healthWarnings";

interface Props {
  code: WarningCode;
  /** Extra classes for the icon (e.g. font size overrides). */
  className?: string;
}

type Anchor = { top: number } & ({ left: number } | { right: number });

/**
 * A single health-warning icon with an on-hover / on-focus tooltip that
 * explains WHY the warning fired (title + reason), so users don't have to
 * open the Health Warnings modal (Shift+H) to understand it.
 */
export default function WarningBadge({ code, className = "" }: Props) {
  const m = WARNING_META[code];
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const open = useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const onLeft = r.left < window.innerWidth / 2;
    setAnchor(
      onLeft
        ? { top: r.top, left: r.left }
        : { top: r.top, right: window.innerWidth - r.right },
    );
  }, []);

  const close = useCallback(() => setAnchor(null), []);

  return (
    <span className="inline-flex items-center align-middle">
      <span
        role="img"
        tabIndex={0}
        aria-label={`Warning: ${m.title}. ${m.description}`}
        className={`leading-none cursor-help select-none outline-none rounded-sm focus-visible:ring-1 focus-visible:ring-acc/60 ${m.colorClass} ${className}`}
        onMouseEnter={(e) => open(e.currentTarget)}
        onMouseLeave={close}
        onFocus={(e) => open(e.currentTarget)}
        onBlur={close}
      >
        {m.icon}
      </span>
      {anchor &&
        createPortal(
          <span
            role="tooltip"
            style={{ position: "fixed", transform: "translateY(-100%)", ...anchor }}
            className="block w-max max-w-72 bg-ink-mid border border-rule rounded shadow-xl z-9999
              px-2.5 py-1.5 pointer-events-none"
          >
            <span className={`block text-[11px] font-semibold mb-0.5 ${m.colorClass}`}>
              {m.icon} {m.title}
            </span>
            <span className="block text-[10.5px] text-soft leading-relaxed">
              {m.description}
            </span>
          </span>,
          document.body,
        )}
    </span>
  );
}
