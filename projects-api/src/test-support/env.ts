/**
 * `bun test` preload (bunfig.toml): the test environment, set before any module reads
 * `src/lib/env` (which validates at import and exits the process on failure).
 *
 * DATABASE_URL: the suite TRUNCATEs tables, so it must never run against the dev
 * database. Whatever DATABASE_URL the shell provides (direnv builds it for `projects`),
 * the tests use the same server's `<name>_test` database; with none, the local compose
 * Postgres' `projects_test`. Create it once with `bun run db:deploy` pointed at it.
 *
 * Everything else is set unconditionally: a developer's real AUTH_* or service-client
 * values must not leak into assertions.
 */

export const TEST_ISSUER = "http://localhost:3001";
export const TEST_AUDIENCE = "operai-suite";
export const TEST_KID = "operai-auth-rs256-v1-test";
/** crm-api is faked by test-support/world.ts's fetch stub, at this origin. */
export const TEST_CRM_URL = "http://crm.test";

function testDatabaseUrl(): string {
  const url = new URL(process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5435/projects_test");
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) url.pathname = `/${name || "projects"}_test`;
  return url.toString();
}

process.env["DATABASE_URL"] = testDatabaseUrl();
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = `${TEST_ISSUER}/auth/jwks`;
process.env["AUTH_ISSUER"] = TEST_ISSUER;
process.env["AUTH_AUDIENCE"] = TEST_AUDIENCE;
process.env["AUTH_BASE_URL"] = TEST_ISSUER;
process.env["NODE_ENV"] = "test";
process.env["CRM_INTERNAL_URL"] = TEST_CRM_URL;
process.env["SERVICE_CLIENT_ID"] = "projects-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-of-32-chars-or-more";
