// Apply stored theme before React mounts to avoid flash of wrong theme.
// Extracted from an inline <script> in index.html (T17, specs/003-suite-shell)
// so the shell's Content-Security-Policy (shell/vercel.json) can omit
// 'unsafe-inline' from script-src — a static external file served same-origin
// is allowed by 'self' alone. Behavior is unchanged: same IIFE, same
// blocking (non-module, non-deferred) <script> position in index.html.
;(function () {
  var t = localStorage.getItem('operai-theme')
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
})()
