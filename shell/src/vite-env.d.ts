/// <reference types="vite/client" />

// Injected at build time by Vite `define` (see vite.config.ts, T6, specs/003-suite-shell).
// Absent under vitest, where src/lib/appInfo.ts falls back to a placeholder version.
declare const __APP_VERSION__: string
