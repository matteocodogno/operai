/**
 * ThemeToggle — cycles system → light → dark → system.
 *
 * Extracted (T6, specs/003-suite-shell, AC-1.4) from the inline theme-toggle button
 * markup previously inside estimai-ui/src/components/Header.tsx (the `themeButton` JSX)
 * plus the cycle handler estimai-ui's EstimatorApp.tsx wired in as `onCycleTheme`.
 *
 * Given its own component boundary here because it's shell-owned chrome, not
 * tool-owned: unlike Header.tsx (which received `theme`/`onCycleTheme` as props from a
 * single parent, EstimatorApp, that also needed the theme value for other purposes),
 * the shell has no such parent — ThemeToggle owns `useTheme()` itself and is a
 * self-contained, prop-less control that can be dropped directly into the header slot.
 */
import { useTheme, THEME_CYCLE, THEME_ICON, THEME_LABEL } from '../hooks/useTheme'

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  const cycleTheme = () => {
    setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length])
  }

  return (
    <button
      onClick={cycleTheme}
      className="w-7 h-7 rounded-full text-[12px] border border-rule text-muted hover:border-acc/50 hover:text-acc transition-colors flex items-center justify-center shrink-0"
      title={THEME_LABEL[theme]}
      aria-label={THEME_LABEL[theme]}
    >
      {THEME_ICON[theme]}
    </button>
  )
}
