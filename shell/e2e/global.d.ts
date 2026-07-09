// Mirrors the ambient augmentation in src/federation/SeedProbeMount.tsx —
// e2e/ is a separate TypeScript program (tsconfig.e2e.json) from src/, so
// the `declare global` there isn't visible here without repeating it.
export {}

declare global {
  interface Window {
    __mfSingletonCheck?: boolean
  }
}
