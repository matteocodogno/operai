/// <reference types="vite/client" />

// Injected at build time by Vite `define` (see vite.config.ts) — this
// remote's own version, exposed via Module Federation as `./version` (see
// src/version.ts). Absent under vitest, where src/version.ts falls back to
// a placeholder.
declare const __REMOTE_VERSION__: string
