/**
 * `bun test` preload (bunfig.toml): the test environment, set before any module reads
 * `src/lib/env` (which validates at import and exits the process on failure).
 *
 * DATABASE_URL: the suite deletes rows, so it must never run against the dev database.
 * Whatever DATABASE_URL the shell provides (direnv builds it for `hours`), the tests use the
 * same server's `<name>_test` database; with none, the local compose Postgres' `hours_test`.
 * Create it once and migrate it with `bun run db:deploy` pointed at it.
 *
 * Everything else is set unconditionally: a developer's real AUTH_*, owner URLs and service
 * credential must not leak into assertions. The URLs of every other service are PLACEHOLDERS
 * on privileged ports nothing listens on: the developer's stack runs on 3001 and 8080-8087
 * while the tests run, and a call a test forgot to fake must be refused, never answered by a
 * real service. Tests that reach an owner or `auth` point the env at their own fake host
 * (test-support/hosts.ts).
 */

export const TEST_ISSUER = "http://auth.test";
/** Where the real JWT middleware fetches its keys; tests of it serve this URL from a stub. */
export const TEST_JWKS_URL = "http://127.0.0.1:6/auth/jwks";
export const TEST_AUDIENCE = "operai-suite";
/** Auth's SERVICE_AUDIENCE: distinct from the user audience (ADR-0044). */
export const TEST_SERVICE_AUDIENCE = "operai-services";
export const TEST_KID = "operai-auth-rs256-v1-test";

function testDatabaseUrl(): string {
  const url = new URL(process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5435/hours_test");
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) url.pathname = `/${name || "hours"}_test`;
  return url.toString();
}

process.env["DATABASE_URL"] = testDatabaseUrl();
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = TEST_JWKS_URL;
process.env["AUTH_ISSUER"] = TEST_ISSUER;
process.env["AUTH_AUDIENCE"] = TEST_AUDIENCE;
process.env["AUTH_BASE_URL"] = "http://127.0.0.1:6";
// The owners: placeholders. Nothing may listen on these ports.
process.env["PROJECTS_API_URL"] = "http://127.0.0.1:1";
process.env["CRM_API_URL"] = "http://127.0.0.1:2";
process.env["ACTIVITIES_API_URL"] = "http://127.0.0.1:3";
process.env["MEETINGS_API_URL"] = "http://127.0.0.1:4";
// A made-up credential, long enough for the 32-character floor and not shaped like a real one.
process.env["SERVICE_CLIENT_ID"] = "hours-api";
process.env["SERVICE_CLIENT_SECRET"] = "x".repeat(40);
process.env["SERVICE_AUDIENCE"] = TEST_SERVICE_AUDIENCE;
process.env["NODE_ENV"] = "test";
