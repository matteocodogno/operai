/**
 * A NUL (U+0000) in any input of any route is a 400, never a 5xx (specs/20261126-teams, QE follow-up F1).
 *
 * `nul.test.ts` proves the global handler on a probe route that throws a hand-built Prisma error. It never goes through a real
 * route, which is how F1 was missed: refund-api wraps every Prisma failure in a `DatabaseError` that the routes render as a 500
 * before the handler is asked. This file goes through the real routers, mounted with the real handler (`problemErrorHandler`):
 *
 *  1. A sweep of the service's OWN OpenAPI document: every path parameter, query parameter and string member of a JSON body of
 *     every operation gets a NUL, one at a time. Free text (a string with no enum, pattern or format) must answer exactly the 400
 *     problem; anything else must at least not answer a 5xx. The set of operations is compared with the routes the app really
 *     registers, so a route added without a doc entry fails the sweep instead of escaping it.
 *  2. The database path: a NUL no schema can refuse (the caller's own `sub`, a server-built value) reaches the driver, the
 *     repo wraps it in a `DatabaseError`, and the route must still answer the 400 and leave the one `[nul]` log line.
 *  3. `runExit` itself.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, spyOn } from "bun:test";
import { Effect } from "effect";
import { OpenAPIHono } from "@hono/zod-openapi";
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
process.env["ACCOUNTING_INTERNAL_URL"] ??= "http://localhost:8089";
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

const { problemErrorHandler } = await import("./errorHandler");
const { runExit } = await import("./runExit");
const { DatabaseError } = await import("./errors");
const { NUL_REFUSAL_LOG_LINE } = await import("./nul");
const { setupOpenAPI } = await import("../openapi/registry");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
/** A router under its own specifier: a file of the suite that imports the plain one gets its own instance, bound to its own auth harness. */
const load = async <T>(specifier: string): Promise<T> => (await import(specifier)) as T;
const routers = [
  (await load<typeof import("../health/health.routes")>("../health/health.routes?nul")).healthRouter,
  (await load<typeof import("../auth/whoami.routes")>("../auth/whoami.routes?nul")).whoamiRouter,
  (await load<typeof import("../requests/requests.routes")>("../requests/requests.routes?nul")).requestsRouter,
  (await load<typeof import("../requests/lines.routes")>("../requests/lines.routes?nul")).linesRouter,
  (await load<typeof import("../requests/export.routes")>("../requests/export.routes?nul")).requestExportRouter,
  (await load<typeof import("../attachments/attachments.routes")>("../attachments/attachments.routes?nul")).attachmentsRouter,
  (await load<typeof import("../requests/lifecycle.routes")>("../requests/lifecycle.routes?nul")).lifecycleRouter,
  (await load<typeof import("../requests/suggestions.routes")>("../requests/suggestions.routes?nul")).suggestionsRouter,
  (await load<typeof import("../review/review.routes")>("../review/review.routes?nul")).reviewRouter,
  (await load<typeof import("../review/decide.routes")>("../review/decide.routes?nul")).decideRouter,
  (await load<typeof import("../batches/batches.routes")>("../batches/batches.routes?nul")).batchesRouter,
  (await load<typeof import("../batches/decide.routes")>("../batches/decide.routes?nul")).batchDecideRouter,
  (await load<typeof import("../rates/routes")>("../rates/routes?nul")).ratesRouter,
  (await load<typeof import("../rates/effective.routes")>("../rates/effective.routes?nul")).rateEffectiveRouter,
  (await load<typeof import("../settings/routes")>("../settings/routes?nul")).settingsRouter,
  (await load<typeof import("../accounting/defaults.routes")>("../accounting/defaults.routes?nul")).defaultsRouter,
  (await load<typeof import("../accounting/classification.routes")>("../accounting/classification.routes?nul")).classificationRouter,
  (await load<typeof import("../accounting/export.routes")>("../accounting/export.routes?nul")).exportRouter,
  (await load<typeof import("../accounting/receiptCode.routes")>("../accounting/receiptCode.routes?nul")).receiptCodeRouter,
];

const app = new OpenAPIHono();
for (const router of routers) app.route("/", router as unknown as OpenAPIHono);
setupOpenAPI(app);
app.onError(problemErrorHandler);

/** Everything the service's capabilities allow, unconditioned: the sweep must reach validation, not stop at a 403. */
const EVERYTHING: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    ["refund", "access"],
    ["request", "create"],
    ["request", "read"],
    ["request", "delete"],
    ["request", "review"],
    ["request", "approve"],
    ["request", "reclassify"],
    ["line", "create"],
    ["rate", "read"],
    ["rate", "manage"],
    ["settings", "read"],
    ["settings", "manage"],
    ["receipt-code", "manage"],
  ].map(([resource, action]) => ({ resource: resource!, action: action!, conditions: null })),
  entity: "welld_it",
  jobTitle: null,
};

beforeEach(async () => {
  await truncateRefundTables();
  harness.setResolve(async () => EVERYTHING);
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

const NUL = "\u0000";

// ─── The OpenAPI document of the real app ────────────────────────────────────────

type Json = Record<string, unknown>;
interface Operation {
  readonly method: string;
  readonly path: string;
  readonly params: readonly { name: string; in: "path" | "query"; required: boolean; schema: Json }[];
  readonly bodyProps: Record<string, Json>;
}

let operations: Operation[] = [];

const METHODS = ["get", "post", "put", "patch", "delete"];

beforeAll(async () => {
  const doc = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, Record<string, Json>>; components?: Json };
  operations = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const params = ((op["parameters"] as Json[] | undefined) ?? [])
        .filter((p) => p["in"] === "path" || p["in"] === "query")
        .map((p) => ({ name: p["name"] as string, in: p["in"] as "path" | "query", required: p["required"] === true, schema: (p["schema"] as Json) ?? {} }));
      const content = ((op["requestBody"] as Json | undefined)?.["content"] as Json | undefined)?.["application/json"] as Json | undefined;
      const bodySchema = (content?.["schema"] as Json | undefined) ?? {};
      const bodyProps = (bodySchema["properties"] as Record<string, Json> | undefined) ?? {};
      operations.push({ method: method.toUpperCase(), path, params, bodyProps });
    }
  }
});

/** Free text: a string nobody constrained to a set, a pattern or a format. Only those must answer the NUL refusal exactly. */
const isFreeText = (schema: Json): boolean => {
  const types = Array.isArray(schema["type"]) ? (schema["type"] as string[]) : [schema["type"] as string];
  const text = types.includes("string") && types.every((t) => t === "string" || t === "null");
  return text && schema["enum"] === undefined && schema["pattern"] === undefined && schema["format"] === undefined && schema["const"] === undefined;
};

const honoPath = (path: string): string[] => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

/** The text of an answer and what it must never hold: the NUL as sent, escaped or percent-encoded. */
function leaks(text: string): boolean {
  return text.includes(NUL) || text.includes("%00") || text.includes("u0000") || /a\u0000b/.test(text);
}

interface Hit {
  readonly label: string;
  readonly status: number;
  readonly text: string;
  readonly freeText: boolean;
}

async function send(op: Operation, where: { kind: "path" | "query" | "body"; name: string }): Promise<Hit> {
  const token = await harness.signToken({ sub: "emp-nul-sweep", email: "emp-nul-sweep@x.com" });
  let path = op.path;
  for (const name of honoPath(op.path)) {
    const value = where.kind === "path" && where.name === name ? `a%00b` : "x";
    path = path.replace(`{${name}}`, value);
  }
  const query = new URLSearchParams();
  for (const p of op.params.filter((q) => q.in === "query")) {
    if (where.kind === "query" && where.name === p.name) query.set(p.name, `a${NUL}b`);
    // The other members must not be the mistake: an optional one is left out, a required one gets a value its schema accepts.
    else if (p.required) query.set(p.name, Array.isArray(p.schema["enum"]) ? String(p.schema["enum"][0]) : "2026-01-15");
  }
  const url = query.size > 0 ? `${path}?${query.toString()}` : path;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (op.method !== "GET" && op.method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(where.kind === "body" ? { [where.name]: `a${NUL}b` } : {});
  }
  const res = await app.request(url, { method: op.method, headers, ...(body !== undefined ? { body } : {}) });
  const schema =
    where.kind === "body" ? op.bodyProps[where.name] : op.params.find((p) => p.in === where.kind && p.name === where.name)?.schema;
  return {
    label: `${op.method} ${op.path} ${where.kind}:${where.name}`,
    status: res.status,
    text: await res.text(),
    freeText: schema !== undefined && isFreeText(schema),
  };
}

describe("a NUL in any input of any route is a 400, never a 5xx (QE F1)", () => {
  it("the sweep sees every route the app registers", () => {
    const registered = new Set(
      app.routes
        .filter((r) => r.method !== "ALL" && !["/openapi.json", "/docs"].includes(r.path))
        .map((r) => `${r.method} ${r.path.replace(/:([A-Za-z]+)/g, "{$1}")}`),
    );
    const swept = new Set(operations.map((o) => `${o.method} ${o.path}`));
    expect([...registered].filter((r) => !swept.has(r))).toEqual([]);
    expect(swept.size).toBeGreaterThan(30);
  });

  it("every path parameter, query parameter and string member of a body: never a 5xx, free text exactly the 400 problem", async () => {
    const bad: string[] = [];
    let probes = 0;
    let freeTextProbes = 0;
    for (const op of operations) {
      const targets: { kind: "path" | "query" | "body"; name: string }[] = [
        ...op.params.map((p) => ({ kind: p.in, name: p.name })),
        ...Object.entries(op.bodyProps)
          .filter(([, schema]) => isFreeText(schema) || schema["type"] === "string")
          .map(([name]) => ({ kind: "body" as const, name })),
      ];
      for (const target of targets) {
        const hit = await send(op, target);
        probes += 1;
        if (hit.status >= 500) bad.push(`${hit.label}: ${hit.status}`);
        else if (leaks(hit.text.replace(/"instance":"[^"]*"/, ""))) bad.push(`${hit.label}: echoes the value`);
        if (hit.freeText) {
          freeTextProbes += 1;
          let problem: Json = {};
          try {
            problem = JSON.parse(hit.text) as Json;
          } catch {
            /* reported below */
          }
          if (hit.status !== 400 || problem["code"] !== "validation_failed") bad.push(`${hit.label}: ${hit.status} ${hit.text.slice(0, 120)}`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(probes).toBeGreaterThan(60);
    expect(freeTextProbes).toBeGreaterThan(40);
  });
});

describe("a NUL that reaches the database through a route is a 400 and one log line (QE F1)", () => {
  const nulSub = `emp-nul${NUL}db`;

  // The caller's own `sub` is server-built text no schema of ours can refuse: it reaches Postgres exactly as an unvalidated id did.
  const CASES: [string, string, Json | undefined][] = [
    ["GET", "/requests", undefined],
    ["POST", "/requests", {}],
    ["GET", "/line-suggestions?type=travel_km", undefined],
  ];

  for (const [method, path, body] of CASES) {
    it(`${method} ${path}: 400 validation_failed, the codes logged, nothing of the value`, async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      warn.mockClear(); // a spy another file leaked carries its calls: count only this request's `[nul]` lines
      const token = await harness.signToken({ sub: nulSub, email: "emp-nul-db@x.com" });
      const res = await app.request(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      const lines = warn.mock.calls.filter((call) => call[0] === NUL_REFUSAL_LOG_LINE);
      warn.mockRestore();
      expect(res.status).toBe(400);
      expect(JSON.parse(text)).toMatchObject({ status: 400, code: "validation_failed" });
      expect(leaks(text.replace(/"instance":"[^"]*"/, ""))).toBe(false);
      expect(lines).toHaveLength(1);
    });
  }
});

describe("runExit", () => {
  const driverRefusal = Object.assign(new Error("secret-note"), { code: "P2039", meta: { driverAdapterError: { name: "DriverAdapterError", cause: { kind: "postgres", code: "22021", originalCode: "22021" } } } });

  it("re-throws the database's refusal of a NUL that a DatabaseError wraps", async () => {
    const wrapped = Effect.fail(new DatabaseError({ message: "Failed", cause: driverRefusal }));
    await expect(runExit(wrapped)).rejects.toBe(driverRefusal);
  });

  it("hands back any other failure as the exit, untouched", async () => {
    const other = new DatabaseError({ message: "Failed", cause: Object.assign(new Error("down"), { code: "P1001" }) });
    const exit = await runExit(Effect.fail(other));
    expect(exit._tag).toBe("Failure");
  });

  it("hands back a success", async () => {
    const exit = await runExit(Effect.succeed(7));
    expect(exit._tag === "Success" && exit.value).toBe(7);
  });
});
