/**
 * Footer — the shell's suite-level footer content (specs/003-suite-shell, T8, AC-1.5).
 *
 * Fills the `footer` slot `ShellLayout` (T5) exposes on its own `<footer
 * role="contentinfo">` landmark — this component renders *inside* that landmark as
 * ordinary content, not a second `<footer>`/landmark of its own (see ShellLayout's
 * "Single-main-landmark note", which applies symmetrically to contentinfo: exactly one
 * contentinfo for the whole document).
 *
 * Deliberately rendered in **normal document flow** by its parent (no `fixed`/`sticky`
 * positioning applied here or by ShellLayout) — see plan.md "Footer placement (design
 * decision)" and design.md's Screens & states → Footer. This is what keeps it from
 * colliding with EstimAI's own tool-scoped, `position: fixed` "⇧? shortcuts" hint
 * (`EstimatorApp.tsx`), which stays exactly as-is and unrelated to this component.
 *
 * Content — legal-information link, version, company info (wellD) — is sourced from
 * ../lib/appInfo, the single place suite-level copy/metadata lives (no hardcoded UI
 * strings, per project CLAUDE.md); `APP_VERSION` reuses the same `__APP_VERSION__`
 * build-time define AboutModal already reads, rather than a second version mechanism.
 */
import { APP_AUTHOR, APP_AUTHOR_URL, APP_NAME, APP_VERSION, LEGAL_URL } from '../lib/appInfo'

export default function Footer() {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-[11px] text-muted">
      <a
        href={LEGAL_URL}
        target="_blank"
        rel="noreferrer"
        className="text-muted hover:text-acc underline underline-offset-2 transition-colors"
      >
        Legal information
      </a>

      <div className="flex items-center gap-3 font-mono">
        <span>
          {APP_NAME} <span data-testid="app-version">v{APP_VERSION}</span>
        </span>
        <span aria-hidden="true" className="text-dim">
          &middot;
        </span>
        <span>
          &copy; {new Date().getFullYear()}{' '}
          <a
            href={APP_AUTHOR_URL}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-acc underline underline-offset-2 transition-colors"
          >
            {APP_AUTHOR}
          </a>
        </span>
      </div>
    </div>
  )
}
