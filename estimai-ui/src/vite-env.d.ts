/// <reference types="vite/client" />

// Injected at build time by Vite `define` (see vite.config.ts). Absent under
// vitest, where appInfo falls back to a placeholder version.
declare const __APP_VERSION__: string
