/**
 * Bun test preload — sets the minimum env vars required by `src/lib/env.ts`
 * before any test module is imported, preventing process.exit(1) in unit tests
 * that do not need a live database or real OAuth credentials.
 *
 * Loaded automatically via [test] preload in bunfig.toml.
 * Do NOT put real secrets here — use placeholder values only.
 */

// Only set vars that are not already in the environment (real CI values take
// precedence over these test stubs).
function setIfAbsent(key: string, value: string): void {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

setIfAbsent("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
setIfAbsent(
  "BETTER_AUTH_SECRET",
  "test-secret-that-is-at-least-32-characters-long",
);
setIfAbsent("BETTER_AUTH_URL", "http://localhost:3001");
setIfAbsent("GOOGLE_CLIENT_ID", "test-google-client-id");
setIfAbsent("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
setIfAbsent("GITHUB_CLIENT_ID", "test-github-client-id");
setIfAbsent("GITHUB_CLIENT_SECRET", "test-github-client-secret");
setIfAbsent("JWT_PRIVATE_KEY", "test-private-key");
setIfAbsent("JWT_PUBLIC_KEY", "test-public-key");
setIfAbsent("ALLOWED_ORIGINS", "http://localhost:5173,https://app.estimai.io");
// UI_HOME_URL: post-login fallback destination (AC-1.3) — validated by the
// env schema; must be an absolute URL.
setIfAbsent("UI_HOME_URL", "http://localhost:5173");
setIfAbsent("NODE_ENV", "test");
// ENABLE_TEST_AUTH is intentionally NOT set here (defaults to disabled).
// Individual test files that need the gate open set it explicitly.
