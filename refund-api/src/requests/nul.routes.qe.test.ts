/**
 * QE of the NUL safety net, round 3 (specs/20261126-teams/qe-followups.md, defect F1).
 *
 * `src/lib/nul.test.ts` proves the global error handler answers 400 for the error a NUL gives *when that error reaches it*. It never
 * goes through a route. On refund-api the repo functions wrap every Prisma failure in a `DatabaseError` (`toDbErr`), and the route maps
 * that to a plain 500 problem ("Unexpected database failure fetching refund request") or, on the lifecycle routes, a 404 that echoes
 * the id, so the safety net is never asked. Live, on the dev stack: `GET /requests/a%00b` -> 500.
 *
 * Fixed (F1): ids are refused at the schema (`lib/inputText.ts`) and a NUL-caused `DatabaseError` is re-thrown to the global handler
 * (`lib/runExit.ts`); `lib/nul.routes.test.ts` sweeps every route.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { setupTestAuth } from "../test-support/testAuth";
import { truncateRefundTables } from "../test-support/dbCleanup";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["SERVICE_CLIENT_ID"] = "refund-api";
process.env["SERVICE_CLIENT_SECRET"] = "test-service-client-secret-at-least-32-characters";

const harness = setupTestAuth();
await harness.init();

const load = async <T>(specifier: string): Promise<T> => (await import(specifier)) as T;
const { requestsRouter } = await load<typeof import("./requests.routes")>("./requests.routes?qe");
const { lifecycleRouter } = await load<typeof import("./lifecycle.routes")>("./lifecycle.routes?qe");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const EMPLOYEE_PERMS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "create", conditions: null },
    { resource: "request", action: "read", conditions: { ownership: "own" } },
  ],
  entity: "welld_it",
  jobTitle: null,
};

beforeEach(async () => {
  await truncateRefundTables();
  harness.setResolve(async () => EMPLOYEE_PERMS);
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

const NUL_ID = "a%00b";

/** The answer a NUL in an id must get: 400 `validation_failed`, the character named, nothing of the value echoed. */
async function expectNulRefusal(res: Response): Promise<void> {
  const text = await res.text();
  expect(res.status).toBe(400);
  expect(JSON.parse(text)).toMatchObject({ status: 400, code: "validation_failed" });
  const { instance: _path, ...rest } = JSON.parse(text) as Record<string, unknown>;
  expect(JSON.stringify(rest)).not.toMatch(/u0000|%00|\u0000|"a/);
}

describe("a NUL in a request id is a 400 on the real routes (QE D2 follow-up, F1)", () => {
  it("GET /requests/{id}: 400, not 500 `Unexpected database failure`", async () => {
    const token = await harness.signToken({ sub: "emp-nul-1", email: "emp-nul-1@x.com" });
    const res = await requestsRouter.request(`/requests/${NUL_ID}`, { headers: { Authorization: `Bearer ${token}` } });
    await expectNulRefusal(res);
  });

  it("POST /requests/{id}/submit: 400, not a 404 that quotes the id", async () => {
    const token = await harness.signToken({ sub: "emp-nul-1", email: "emp-nul-1@x.com" });
    const res = await lifecycleRouter.request(`/requests/${NUL_ID}/submit`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    await expectNulRefusal(res);
  });
});
