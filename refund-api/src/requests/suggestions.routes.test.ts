/**
 * Integration tests for `GET /line-suggestions` (T6, specs/014-motivo-autocomplete).
 *
 * Real Hono router, REAL compose Postgres; only the two network-calling
 * dependencies (`jwt.middleware`, `authz/resolveClient`) are mocked, via
 * `src/test-support/testAuth.ts` — the same strategy as every other route
 * test in this service. Cleaned with `truncateRefundTables()`.
 *
 * AC coverage (T6 done-when + plan § Test strategy)
 * ─────────────────────────────────────────────────
 * AC-1.7  count + lastUsedOn present and correct per group; count non-increasing
 * AC-2.1  folded-equal variants across several requests collapse to ONE suggestion
 * AC-2.2  same motivo + different km / different entity never merge
 * AC-2.3  ranking: count desc, then lastUsedOn desc
 * AC-2.4  a 25-month-old line is ABSENT and does NOT inflate an otherwise
 *         identical in-window group's count; a 23-month-old line is present
 * AC-2.5  display motivo is the most recent line's verbatim text
 * AC-2.6  all five request statuses contribute, draft included
 * AC-4.1  cross-owner isolation, both directions (A never sees B; B never
 *         inflates A's counts)
 * AC-4.2  a caller holding GLOBAL-scope `request:review` still gets only their own
 * AC-4.3  the resolve-fixture matrix — missing `request:read` is 403, never
 *         200 and never 404; no parameter addresses another subject
 * AC-4.4  no row is created/updated/deleted in ANY refund table, and captured
 *         console output during the call contains no motivo text
 * plan D7 `Cache-Control: no-store`
 * plan §  the registration-order trap: the route lives at TOP LEVEL and is
 *         NOT swallowed by `GET /requests/{id}`
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { ResolveResponse } from "../authz/resolveClient";
import { setupTestAuth } from "../test-support/testAuth";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] = "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["REFUND_S3_ENDPOINT"] = "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";
process.env["REFUND_APP_BASE_URL"] = "http://localhost:5173";

const harness = setupTestAuth();
await harness.init();

// Dynamic, AFTER the env assignments above — src/lib/env.ts validates at
// import time and `process.exit(1)`s on a missing var, so a static import of
// anything that reaches `db` would make this file un-runnable on its own
// (`bun test suggestions`).
const { suggestionsRouter, LINE_SUGGESTIONS_PATH } = await import("./suggestions.routes");
const { db } = await import("../lib/db");
const { truncateRefundTables } = await import("../test-support/dbCleanup");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

// ─── Resolve fixtures (AC-4.3's matrix) ─────────────────────────────────────

const perms = (
  list: readonly { resource: string; action: string; conditions: unknown }[],
  entity: string | null = null,
): ResolveResponse =>
  ({
    sub: "",
    epoch: 1,
    permissions: list,
    entity,
    jobTitle: null,
  }) as ResolveResponse;

/** A plain employee — the ordinary caller of this endpoint. */
const EMPLOYEE = perms(
  [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "create", conditions: null },
    { resource: "request", action: "read", conditions: { ownership: "own" } },
  ],
  "welld_it",
);

/** Accounting scoped to welld_it — holds review over OTHER employees' requests. */
const ACCOUNTING_WELLD_IT = perms(
  [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "read", conditions: { ownership: "own" } },
    {
      resource: "request",
      action: "review",
      conditions: { attributes: [{ key: "entity", match: "user" }] },
    },
  ],
  "welld_it",
);

/**
 * Accounting with GLOBAL review scope — an UNCONDITIONED `request:review`,
 * which is exactly how ADR-0015's widest-wins union expresses "sees every
 * entity". This is AC-4.2's caller.
 */
const ACCOUNTING_GLOBAL = perms(
  [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "read", conditions: { ownership: "own" } },
    { resource: "request", action: "review", conditions: null },
    { resource: "request", action: "approve", conditions: null },
  ],
  null,
);

/**
 * The pathological case: an UNCONDITIONED `request:read` (no `ownership:own`)
 * PLUS unconditioned review. If the handler consulted the grant's conditions
 * at all, this is the fixture that would widen the read.
 */
const UNCONDITIONED_READ = perms(
  [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "read", conditions: null },
    { resource: "request", action: "review", conditions: null },
  ],
  null,
);

/** `request:read` and nothing else — the minimum that must still work. */
const READ_ONLY = perms([
  { resource: "request", action: "read", conditions: { ownership: "own" } },
]);

/** Signed in, but holds no refund grants at all. */
const NO_GRANTS = perms([]);

/** Holds the refund tool and can create, but NOT read — the 403 case. */
const NO_READ_CAPABILITY = perms([
  { resource: "refund", action: "access", conditions: null },
  { resource: "request", action: "create", conditions: null },
  { resource: "request", action: "review", conditions: null },
]);

// ─── Seeding helpers ────────────────────────────────────────────────────────

const OWNER = { sub: "emp-suggest-a", email: "emp-suggest-a@welld.ch" };
const OTHER = { sub: "emp-suggest-b", email: "emp-suggest-b@welld.ch" };

type Entity = "welld_it" | "welld_ch";
type Status = "draft" | "submitted" | "approved" | "rejected" | "paid";

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

async function makeRequest(
  owner: { sub: string; email: string },
  status: Status = "draft",
): Promise<string> {
  const row = await db.refundRequest.create({
    data: { ownerUserId: owner.sub, ownerEmail: owner.email, status },
  });
  return row.id;
}

interface SeedLine {
  readonly motivo: string;
  readonly km?: number;
  readonly entity?: Entity;
  /** `YYYY-MM-DD`. */
  readonly date?: string;
  readonly type?: "travel_km" | "travel_train" | "office_material";
}

async function seedLine(requestId: string, line: SeedLine): Promise<void> {
  const entity: Entity = line.entity ?? "welld_it";
  const type = line.type ?? "travel_km";
  await db.refundLine.create({
    data: {
      requestId,
      date: new Date(`${line.date ?? "2026-06-01"}T00:00:00.000Z`),
      type,
      motivo: line.motivo,
      entity,
      currency: entity === "welld_ch" ? "CHF" : "EUR",
      requestedAmountCents: 1000,
      ...(type === "travel_km" ? { km: line.km ?? 62 } : {}),
    },
  });
}

/**
 * A date `months` whole months before today, built with the SAME `Date.UTC`
 * month arithmetic the cutoff uses — so the relationship "25 months ago is
 * strictly older than the 24-month cutoff, 23 months ago is strictly newer"
 * holds on every calendar day this suite is ever run, rather than only on the
 * day it was written.
 */
function monthsAgo(months: number): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()),
  );
  return d.toISOString().slice(0, 10);
}

interface WireSuggestion {
  motivo: string;
  normalisedMotivo: string;
  km: number;
  entity: Entity;
  count: number;
  lastUsedOn: string;
}

async function callAs(
  who: { sub: string; email: string },
  resolve: ResolveResponse,
  query = "?type=travel_km",
): Promise<Response> {
  const token = await harness.signToken({ sub: who.sub, email: who.email });
  harness.setResolve(async () => resolve);
  return suggestionsRouter.request(`${LINE_SUGGESTIONS_PATH}${query}`, {
    headers: authHeaders(token),
  });
}

async function suggestionsFor(
  who: { sub: string; email: string },
  resolve: ResolveResponse = EMPLOYEE,
): Promise<WireSuggestion[]> {
  const res = await callAs(who, resolve);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { type: string; suggestions: WireSuggestion[] };
  expect(body.type).toBe("travel_km");
  return body.suggestions;
}

beforeEach(async () => {
  await truncateRefundTables();
  harness.setResolve(async () => EMPLOYEE);
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

// ─── Routing: the registration-order trap ───────────────────────────────────

describe("route registration (the /requests/{id} swallow trap)", () => {
  it("the route is mounted at TOP LEVEL, not under /requests", () => {
    expect(LINE_SUGGESTIONS_PATH).toBe("/line-suggestions");
    expect(LINE_SUGGESTIONS_PATH.startsWith("/requests")).toBe(false);
  });

  it("resolves at GET /line-suggestions even when a /requests/{id} router is registered FIRST", async () => {
    // Mirrors src/index.ts's registration order with a stand-in for
    // requestsRouter's `GET /requests/:id` — the route that WOULD have
    // swallowed `/requests/line-suggestions` as `id="line-suggestions"`. Using
    // a stand-in rather than the real requestsRouter keeps this file from
    // importing a router another test file already `mock.module`s (see
    // test-support/testAuth.ts's header on cross-file mock collisions).
    const requestsLike = new Hono();
    requestsLike.get("/requests/:id", (c) =>
      c.json({ swallowedBy: "GET /requests/:id", id: c.req.param("id") }, 200),
    );

    const app = new Hono();
    app.route("/", requestsLike); // registered FIRST, exactly as in src/index.ts
    app.route("/", suggestionsRouter);

    const requestId = await makeRequest(OWNER);
    await seedLine(requestId, { motivo: "Milano → Lugano", km: 62 });

    const token = await harness.signToken(OWNER);
    harness.setResolve(async () => EMPLOYEE);

    const res = await app.request("/line-suggestions?type=travel_km", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["swallowedBy"]).toBeUndefined();
    expect(body["type"]).toBe("travel_km");

    // And this is the trap itself, demonstrated rather than asserted from
    // memory: had the route been mounted under /requests, THIS is what the
    // caller would have got instead.
    const trapped = await app.request("/requests/line-suggestions?type=travel_km", {
      headers: authHeaders(token),
    });
    const trappedBody = (await trapped.json()) as Record<string, unknown>;
    expect(trappedBody["swallowedBy"]).toBe("GET /requests/:id");
    expect(trappedBody["id"]).toBe("line-suggestions");
  });
});

// ─── AC-4.3: the capability gate and the resolve-fixture matrix ─────────────

describe("authorization (AC-4.3)", () => {
  it("401 without a Bearer token", async () => {
    const res = await suggestionsRouter.request(`${LINE_SUGGESTIONS_PATH}?type=travel_km`);
    expect(res.status).toBe(401);
  });

  it("(AC-4.3) 403 — never 404, never 200 — when `request:read` is absent", async () => {
    const requestId = await makeRequest(OWNER);
    await seedLine(requestId, { motivo: "Milano → Lugano" });

    for (const fixture of [NO_GRANTS, NO_READ_CAPABILITY]) {
      const res = await callAs(OWNER, fixture);
      expect(res.status).toBe(403);
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(200);

      const problem = (await res.json()) as Record<string, unknown>;
      expect(problem["status"]).toBe(403);
      expect(problem["title"]).toBe("Forbidden");
      expect(problem["detail"]).toBe(
        "You do not have permission to read refund requests",
      );
      // The denial body leaks nothing about whether the caller HAS any lines.
      expect(JSON.stringify(problem)).not.toContain("Milano");
      __resetAuthzCacheForTests();
    }
  });

  it("(AC-4.3) every granting fixture returns the CALLER'S OWN lines and nothing else", async () => {
    const mine = await makeRequest(OWNER);
    await seedLine(mine, { motivo: "My own trip", km: 10 });

    const theirs = await makeRequest(OTHER, "approved");
    await seedLine(theirs, { motivo: "Colleague secret client", km: 10 });
    await seedLine(theirs, { motivo: "My own trip", km: 10 }); // identical signature!

    for (const fixture of [
      EMPLOYEE,
      ACCOUNTING_WELLD_IT,
      ACCOUNTING_GLOBAL,
      UNCONDITIONED_READ,
      READ_ONLY,
    ]) {
      __resetAuthzCacheForTests();
      const suggestions = await suggestionsFor(OWNER, fixture);

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.motivo).toBe("My own trip");
      // The colleague's identical-signature line must not inflate the count.
      expect(suggestions[0]?.count).toBe(1);
      expect(JSON.stringify(suggestions)).not.toContain("Colleague");
    }
  });

  it("(AC-4.3) an unknown query parameter is rejected (400), not silently ignored", async () => {
    // There is no `q`, no `userId`, no `id` on this route — and a caller who
    // tries one gets a refusal rather than a quietly-stripped parameter.
    for (const query of [
      "?type=travel_km&userId=emp-suggest-b",
      "?type=travel_km&ownerUserId=emp-suggest-b",
      "?type=travel_km&q=milano",
    ]) {
      __resetAuthzCacheForTests();
      const res = await callAs(OWNER, EMPLOYEE, query);
      expect(res.status).toBe(400);
    }
  });

  it("400 on a missing or non-travel_km type", async () => {
    for (const query of ["", "?type=", "?type=office_material", "?type=travel_train"]) {
      __resetAuthzCacheForTests();
      const res = await callAs(OWNER, EMPLOYEE, query);
      expect(res.status).toBe(400);
      const problem = (await res.json()) as Record<string, unknown>;
      expect(problem["status"]).toBe(400);
      expect(problem["title"]).toBe("Bad Request");
    }
  });
});

// ─── AC-4.1 / AC-4.2: owner scoping ─────────────────────────────────────────

describe("owner scoping (AC-4.1, AC-4.2)", () => {
  beforeEach(async () => {
    const mine = await makeRequest(OWNER);
    await seedLine(mine, { motivo: "Milano → Lugano", km: 62, date: "2026-06-01" });
    await seedLine(mine, { motivo: "Milano → Lugano", km: 62, date: "2026-06-02" });

    const theirs = await makeRequest(OTHER, "submitted");
    // Deliberately the SAME trip signature, so a scope leak shows up as an
    // inflated count and not merely as an extra row.
    await seedLine(theirs, { motivo: "Milano → Lugano", km: 62, date: "2026-07-01" });
    await seedLine(theirs, { motivo: "Zurigo cliente riservato", km: 30, date: "2026-07-01" });
  });

  it("(AC-4.1) A sees only A's lines, and B's identical trip does not inflate A's count", async () => {
    const suggestions = await suggestionsFor(OWNER);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.count).toBe(2);
    expect(suggestions[0]?.lastUsedOn).toBe("2026-06-02");
    expect(JSON.stringify(suggestions)).not.toContain("Zurigo");
  });

  it("(AC-4.1) B sees only B's lines — the isolation holds in both directions", async () => {
    __resetAuthzCacheForTests();
    const suggestions = await suggestionsFor(OTHER);

    expect(suggestions.map((s) => s.motivo).sort()).toEqual([
      "Milano → Lugano",
      "Zurigo cliente riservato",
    ]);
    const milano = suggestions.find((s) => s.motivo === "Milano → Lugano");
    expect(milano?.count).toBe(1); // A's two lines did not leak in
  });

  it("(AC-4.2) a caller holding GLOBAL-scope request:review still gets only their own lines", async () => {
    __resetAuthzCacheForTests();
    const suggestions = await suggestionsFor(OWNER, ACCOUNTING_GLOBAL);

    // The same caller can legitimately REVIEW B's request (unconditioned
    // review = every entity, ADR-0015) — and still sees none of it here.
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.count).toBe(2);
    expect(JSON.stringify(suggestions)).not.toContain("Zurigo");
  });

  it("(AC-4.2) an UNCONDITIONED request:read grant does not widen the read either", async () => {
    __resetAuthzCacheForTests();
    const suggestions = await suggestionsFor(OWNER, UNCONDITIONED_READ);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.count).toBe(2);
  });

  it("a caller with no lines at all gets an empty list, not an error", async () => {
    __resetAuthzCacheForTests();
    const suggestions = await suggestionsFor(
      { sub: "emp-with-nothing", email: "nothing@welld.ch" },
      EMPLOYEE,
    );
    expect(suggestions).toEqual([]);
  });
});

// ─── AC-2.1 / AC-2.2 / AC-2.5: grouping ─────────────────────────────────────

describe("grouping (AC-2.1, AC-2.2, AC-2.5)", () => {
  it("(AC-2.1) five folded-equal lines across three requests collapse to ONE suggestion", async () => {
    const r1 = await makeRequest(OWNER, "draft");
    const r2 = await makeRequest(OWNER, "submitted");
    const r3 = await makeRequest(OWNER, "approved");

    await seedLine(r1, { motivo: "Milano  →  LUGANO ", date: "2026-01-05" });
    await seedLine(r1, { motivo: "milano → lugano", date: "2026-02-05" });
    await seedLine(r2, { motivo: "Milano → Lugàno", date: "2026-03-05" });
    await seedLine(r2, { motivo: "MILANO → LUGANO", date: "2026-04-05" });
    await seedLine(r3, { motivo: "milano  →  lugano", date: "2026-05-05" });

    const suggestions = await suggestionsFor(OWNER);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.count).toBe(5);
    expect(suggestions[0]?.normalisedMotivo).toBe("milano → lugano");
    expect(suggestions[0]?.lastUsedOn).toBe("2026-05-05");
  });

  it("(AC-2.2) same motivo, different km → two separate suggestions", async () => {
    const r = await makeRequest(OWNER);
    await seedLine(r, { motivo: "Milano → Lugano", km: 62 });
    await seedLine(r, { motivo: "Milano → Lugano", km: 64 });

    const suggestions = await suggestionsFor(OWNER);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.km).sort((a, b) => a - b)).toEqual([62, 64]);
    expect(suggestions.every((s) => s.count === 1)).toBe(true);
  });

  it("(AC-2.2) same motivo, different entity → two separate suggestions", async () => {
    const r = await makeRequest(OWNER);
    await seedLine(r, { motivo: "Milano → Lugano", km: 62, entity: "welld_it" });
    await seedLine(r, { motivo: "Milano → Lugano", km: 62, entity: "welld_ch" });

    const suggestions = await suggestionsFor(OWNER);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.entity).sort()).toEqual(["welld_ch", "welld_it"]);
  });

  it("(AC-2.5) shows the MOST RECENT line's motivo verbatim, never the folded form", async () => {
    const r = await makeRequest(OWNER);
    // The older variant is also the more frequent one, so this cannot pass by
    // accidentally electing the most popular text.
    await seedLine(r, { motivo: "milano lugano", date: "2025-01-01" });
    await seedLine(r, { motivo: "milano lugano", date: "2025-02-01" });
    await seedLine(r, { motivo: "milano lugano", date: "2025-03-01" });
    await seedLine(r, { motivo: "Milano  →  LUGANO", date: "2026-04-02" });
    await seedLine(r, { motivo: "milano → lugano", date: "2026-04-01" });

    const suggestions = await suggestionsFor(OWNER);

    const arrowTrip = suggestions.find((s) => s.normalisedMotivo === "milano → lugano");
    expect(arrowTrip?.motivo).toBe("Milano  →  LUGANO");
    expect(arrowTrip?.count).toBe(2);
    // The fold is a comparison key, never display text.
    expect(arrowTrip?.motivo).not.toBe(arrowTrip?.normalisedMotivo);

    const plainTrip = suggestions.find((s) => s.normalisedMotivo === "milano lugano");
    expect(plainTrip?.motivo).toBe("milano lugano");
    expect(plainTrip?.count).toBe(3);
  });

  it("ignores every non-travel_km line, whatever its motivo", async () => {
    const r = await makeRequest(OWNER);
    await seedLine(r, { motivo: "Train to Roma", type: "travel_train" });
    await seedLine(r, { motivo: "Printer paper", type: "office_material" });
    await seedLine(r, { motivo: "Milano → Lugano", type: "travel_km" });

    const suggestions = await suggestionsFor(OWNER);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.motivo).toBe("Milano → Lugano");
  });
});

// ─── AC-2.3 / AC-1.7: ranking and the displayed facts ───────────────────────

describe("ranking and displayed facts (AC-2.3, AC-1.7)", () => {
  it("(AC-2.3) orders by count desc, then lastUsedOn desc", async () => {
    const r = await makeRequest(OWNER);
    // "popular": 3 lines, oldest dates. "recent"/"older": 2 lines each,
    // separated only by date — so both ranking keys are exercised. `popular`
    // being the OLDEST group is the whole point: it ranks FIRST only because
    // `count` outranks `lastUsedOn`, and it would rank LAST under date alone.
    //
    // Relative dates (`monthsAgo`), never calendar literals: every one of
    // these must stay inside the 24-month window on every day this suite is
    // ever run. Hardcoded 2024-09-xx dates here would have silently fallen out
    // of the window on 2026-09-02, dropping `popular`'s count from 3 to 2 and
    // reddening CI with no code change. All offsets sit well inside the
    // window, and adjacent offsets differ by a whole month, so the ordering
    // survives `Date.UTC`'s month-overflow normalisation on every calendar day.
    await seedLine(r, { motivo: "popular", km: 1, date: monthsAgo(14) });
    await seedLine(r, { motivo: "popular", km: 1, date: monthsAgo(13) });
    await seedLine(r, { motivo: "popular", km: 1, date: monthsAgo(12) });
    await seedLine(r, { motivo: "recent", km: 2, date: monthsAgo(2) });
    await seedLine(r, { motivo: "recent", km: 2, date: monthsAgo(1) });
    await seedLine(r, { motivo: "older", km: 3, date: monthsAgo(8) });
    await seedLine(r, { motivo: "older", km: 3, date: monthsAgo(7) });

    const suggestions = await suggestionsFor(OWNER);

    expect(suggestions.map((s) => s.motivo)).toEqual(["popular", "recent", "older"]);
    expect(suggestions.map((s) => s.count)).toEqual([3, 2, 2]);
    // Pins the two properties the assertion above depends on for its meaning,
    // so a future reseeding cannot quietly make it vacuous: the FIRST entry is
    // the LEAST recent (count beat recency), and the 2nd/3rd — tied on count —
    // are in strict recency order (recency broke the tie, not the alphabet,
    // which would have put "older" ahead of "recent").
    expect(suggestions.map((s) => s.lastUsedOn)).toEqual([
      monthsAgo(12),
      monthsAgo(1),
      monthsAgo(7),
    ]);
  });

  it("(AC-1.7) every suggestion carries all five facts, and counts never increase down the list", async () => {
    const r = await makeRequest(OWNER);
    await seedLine(r, { motivo: "Aeroporto Malpensa", km: 45, entity: "welld_it", date: "2026-02-01" });
    await seedLine(r, { motivo: "Aeroporto Malpensa", km: 45, entity: "welld_it", date: "2026-03-01" });
    await seedLine(r, { motivo: "Cliente ACME", km: 62, entity: "welld_ch", date: "2026-04-01" });

    const suggestions = await suggestionsFor(OWNER);

    for (const s of suggestions) {
      expect(typeof s.motivo).toBe("string");
      expect(s.motivo.length).toBeGreaterThan(0);
      expect(Number.isInteger(s.km)).toBe(true);
      expect(["welld_it", "welld_ch"]).toContain(s.entity);
      expect(Number.isInteger(s.count)).toBe(true);
      expect(s.count).toBeGreaterThan(0);
      expect(s.lastUsedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    const malpensa = suggestions.find((s) => s.motivo === "Aeroporto Malpensa");
    expect(malpensa).toEqual({
      motivo: "Aeroporto Malpensa",
      normalisedMotivo: "aeroporto malpensa",
      km: 45,
      entity: "welld_it",
      count: 2,
      lastUsedOn: "2026-03-01",
    });

    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i]!.count).toBeLessThanOrEqual(suggestions[i - 1]!.count);
    }
  });
});

// ─── AC-2.4: the 24-month window ────────────────────────────────────────────

describe("suggestion window (AC-2.4)", () => {
  it("a 25-month-old line is absent AND does not inflate an identical in-window group", async () => {
    const r = await makeRequest(OWNER);

    // Two in-window lines of one trip...
    await seedLine(r, { motivo: "Recurring commute", km: 20, date: monthsAgo(1) });
    await seedLine(r, { motivo: "Recurring commute", km: 20, date: monthsAgo(23) });
    // ...plus a THIRD line with the identical signature, just out of window.
    await seedLine(r, { motivo: "Recurring commute", km: 20, date: monthsAgo(25) });
    // ...and an out-of-window trip that exists ONLY outside the window.
    await seedLine(r, { motivo: "Ancient forgotten trip", km: 77, date: monthsAgo(25) });

    const suggestions = await suggestionsFor(OWNER);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.motivo).toBe("Recurring commute");
    // 2, not 3 — the 25-month-old line contributed nothing to the count
    // (AC-2.4's "neither appears ... nor contributes to any group's count").
    expect(suggestions[0]?.count).toBe(2);
    // ...nor to the ordering signal.
    expect(suggestions[0]?.lastUsedOn).toBe(monthsAgo(1));
    expect(JSON.stringify(suggestions)).not.toContain("Ancient");
  });

  it("a 23-month-old line IS present", async () => {
    const r = await makeRequest(OWNER);
    await seedLine(r, { motivo: "Just inside the window", km: 33, date: monthsAgo(23) });

    const suggestions = await suggestionsFor(OWNER);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.lastUsedOn).toBe(monthsAgo(23));
  });
});

// ─── AC-2.6: every status contributes ───────────────────────────────────────

describe("request status (AC-2.6)", () => {
  it("all five statuses — draft included — contribute to counts and appear", async () => {
    const statuses: Status[] = ["draft", "submitted", "approved", "rejected", "paid"];

    for (const status of statuses) {
      const r = await makeRequest(OWNER, status);
      // One line on a SHARED signature (proves each status contributes to the
      // count) and one status-unique line (proves each status appears at all).
      await seedLine(r, { motivo: "Shared across statuses", km: 50, date: "2026-05-01" });
      await seedLine(r, { motivo: `Only in ${status}`, km: 11, date: "2026-05-01" });
    }

    const suggestions = await suggestionsFor(OWNER);

    const shared = suggestions.find((s) => s.motivo === "Shared across statuses");
    expect(shared?.count).toBe(5);

    for (const status of statuses) {
      expect(suggestions.some((s) => s.motivo === `Only in ${status}`)).toBe(true);
    }
  });
});

// ─── AC-4.4: nothing is written, nothing is logged ──────────────────────────

describe("no new store, log or record (AC-4.4)", () => {
  const tableCounts = async () => ({
    refund_line: await db.refundLine.count(),
    refund_request: await db.refundRequest.count(),
    refund_audit_entry: await db.refundAuditEntry.count(),
    refund_setting: await db.refundSetting.count(),
    mileage_rate: await db.mileageRate.count(),
  });

  it("creates, updates and deletes nothing in any refund table", async () => {
    const r = await makeRequest(OWNER);
    await seedLine(r, { motivo: "Milano → Lugano", km: 62 });
    await seedLine(r, { motivo: "Aeroporto Malpensa", km: 45 });
    await db.mileageRate.create({
      data: {
        entity: "welld_it",
        currency: "EUR",
        ratePerKmMicros: 500000,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        createdByUserId: "admin-1",
        createdByEmail: "admin@welld.ch",
      },
    });
    await db.refundSetting.create({
      data: {
        key: "accounting-distribution-email",
        value: "accounting@welld.ch",
        createdByUserId: "admin-1",
        createdByEmail: "admin@welld.ch",
      },
    });

    const before = await tableCounts();
    // Also snapshot the mutable columns of the rows the read touches, so an
    // in-place UPDATE (which a pure row count would miss) is caught too.
    const linesBefore = await db.refundLine.findMany({ orderBy: { id: "asc" } });

    const suggestions = await suggestionsFor(OWNER);
    expect(suggestions).toHaveLength(2);

    const after = await tableCounts();
    expect(after).toEqual(before);

    const linesAfter = await db.refundLine.findMany({ orderBy: { id: "asc" } });
    expect(linesAfter).toEqual(linesBefore);
  });

  it("writes no motivo text to any console channel during the call", async () => {
    const SECRET_MOTIVO = "Zzz Confidential Client Site Visit";

    const r = await makeRequest(OWNER);
    await seedLine(r, { motivo: SECRET_MOTIVO, km: 62 });

    const captured: string[] = [];
    const channels = ["log", "info", "warn", "error", "debug"] as const;
    const originals = channels.map((name) => [name, console[name]] as const);

    for (const name of channels) {
      console[name] = (...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      };
    }

    try {
      // Mounted behind the REAL requestLogger, since that is the component
      // whose path-only posture (src/lib/logger.ts) this assertion protects.
      const { requestLogger } = await import("../lib/logger");
      const app = new Hono();
      app.use("*", requestLogger());
      app.route("/", suggestionsRouter);

      const token = await harness.signToken(OWNER);
      harness.setResolve(async () => EMPLOYEE);

      const res = await app.request(`${LINE_SUGGESTIONS_PATH}?type=travel_km`, {
        headers: authHeaders(token),
      });
      expect(res.status).toBe(200);
    } finally {
      for (const [name, fn] of originals) {
        console[name] = fn;
      }
    }

    const output = captured.join("\n");
    expect(output).not.toContain(SECRET_MOTIVO);
    expect(output).not.toContain("Confidential");
    expect(output).not.toContain("Zzz");
    // The caller's identity must not be logged either.
    expect(output).not.toContain(OWNER.sub);
    expect(output).not.toContain(OWNER.email);
    // The logger DID run — this test would pass vacuously otherwise.
    expect(output).toContain("GET /line-suggestions 200");
  });
});

// ─── OpenAPI registration ───────────────────────────────────────────────────

describe("OpenAPI", () => {
  it("generates a valid spec entry under the new Suggestions tag", async () => {
    // `.strict()` on a query object is unusual in this codebase — this pins
    // that it does not break zod-to-openapi's parameter generation, which
    // would otherwise only surface as a broken /docs page in production.
    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const { setupOpenAPI } = await import("../openapi/registry");

    const app = new OpenAPIHono();
    app.route("/", suggestionsRouter);
    setupOpenAPI(app);

    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);

    const doc = (await res.json()) as {
      tags: { name: string }[];
      paths: Record<string, Record<string, { tags: string[]; parameters?: unknown[] }>>;
    };

    expect(doc.tags.map((t) => t.name)).toContain("Suggestions");

    const operation = doc.paths[LINE_SUGGESTIONS_PATH]?.["get"];
    expect(operation).toBeDefined();
    expect(operation?.tags).toEqual(["Suggestions"]);
    // Exactly one documented parameter — `type`, and nothing else (AC-4.3).
    expect(operation?.parameters).toHaveLength(1);
    expect((operation?.parameters as { name: string }[])[0]?.name).toBe("type");

    // The route is not documented anywhere under /requests.
    expect(
      Object.keys(doc.paths).filter((p) => p.includes("line-suggestions")),
    ).toEqual([LINE_SUGGESTIONS_PATH]);
  });
});

// ─── plan D7: the response is never cached ──────────────────────────────────

describe("caching (plan D7)", () => {
  it("sets Cache-Control: no-store on the 200", async () => {
    const r = await makeRequest(OWNER);
    await seedLine(r, { motivo: "Milano → Lugano", km: 62 });

    const res = await callAs(OWNER, EMPLOYEE);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sets Cache-Control: no-store on the 403 too", async () => {
    const res = await callAs(OWNER, NO_GRANTS);
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
