/**
 * Test preload (bunfig.toml [test] preload): the environment `src/lib/env.ts`
 * validates at import, so a test file never has to set it. `??=` throughout, so a
 * developer's real values (DATABASE_URL above all: `bun test` shares ONE process)
 * are never overwritten. The default DATABASE_URL is the compose Postgres from
 * AGENTS.md; where its credentials differ (direnv/1Password), export
 * DATABASE_URL pointing at a `meetings_test` database before `bun test`.
 *
 * Values the suite asserts on (issuer, audience) are set unconditionally.
 */
process.env["DATABASE_URL"] ??= "postgresql://postgres:postgres@localhost:5435/meetings_test";
process.env["ALLOWED_ORIGINS"] ??= "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["NODE_ENV"] = "test";
// Bucket (never reached in unit tests: storage is faked) and providers.
process.env["MEETINGS_S3_ENDPOINT"] ??= "http://localhost:9000";
process.env["MEETINGS_S3_REGION"] ??= "us-east-1";
process.env["MEETINGS_S3_BUCKET"] ??= "operai-meetings-test";
process.env["MEETINGS_S3_ACCESS_KEY_ID"] ??= "test-access-key";
process.env["MEETINGS_S3_SECRET_ACCESS_KEY"] ??= "test-secret-key";
process.env["MEETINGS_S3_EU_ENDPOINT_HOSTS"] ??= "localhost";
process.env["MEETINGS_AI_PROVIDER"] = "fake";
