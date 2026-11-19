/**
 * Integration tests of the ledger-account routes (T8, specs/20261119-accounting; moved from refund-api's catalog
 * route tests and adapted): the REAL assembled app (`../index`), a fake `auth GET /authz/resolve` through the shared
 * harness, and the real `accounting` Postgres database.
 *
 * AC coverage (plan § Test strategy, accounts): 1.1 add and list, 1.2 limits and trimming, 1.3 duplicate (also
 * deactivated, other entity, racing), 1.4 deactivate stays listed, 1.9 reactivate, 1.11 already in the state and the
 * races, 1.12 no PUT/PATCH/DELETE, 1.13 who, when, entity and before/after on the status rows, 3.4 a reader writes
 * nothing, 3.5 an uncovered entity is not found, 3.6 no grant gets no data, 8.3 an empty entity is an empty list.
 * The VAT codes (T9): 1.5 add, upper-casing, rate in basis points and the limits, 1.6 duplicate ignoring case,
 * 1.7 the rate cannot be changed, 1.8 and 1.10 deactivate and reactivate, 1.11 races, 1.13 status rows, 3.4, 3.5, 8.3.
 * The system read of the same entries (AC-1.1, AC-1.4, AC-1.8, AC-1.9, AC-1.10 "also in the system read") is proved
 * with the system routes (T13).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { fakeResolve, PERSONAS, type Persona } from "../test-support/fakeResolve";
import { SQLSTATE, truncateAccountingTables, violation } from "../test-support/dbCleanup";
import { setupTestAuth } from "../test-support/testAuth";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../authz/authz.middleware");
const { percentToBasisPoints, basisPointsToPercent, compareAccountNumbers } = await import("./catalog.repo");

interface CallOptions {
  readonly body?: unknown;
  readonly raw?: string;
  readonly as?: Persona;
  readonly sub?: string;
  readonly email?: string;
  readonly token?: boolean;
}

async function call(method: string, path: string, opts: CallOptions = {}) {
  __resetAuthzCacheForTests(); // the middleware caches per (sub, epoch): every call resolves afresh
  harness.setResolve(fakeResolve(opts.as ?? PERSONAS.accountingCh));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== false) {
    const as = opts.as ?? PERSONAS.accountingCh;
    headers["Authorization"] = `Bearer ${await harness.signToken({ sub: opts.sub ?? as.sub, email: opts.email ?? `${as.sub}@welld.ch` })}`;
  }
  const res = await app.request(path, {
    method,
    headers,
    ...(opts.raw !== undefined ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    body = { text };
  }
  return { status: res.status, body };
}

const ACCOUNTS = (entity = "welld_ch") => `/v1/entities/${entity}/ledger-accounts`;
const addAccount = (number = "5905", name = "Spese rimborsi chilometrici", opts: CallOptions & { entity?: string } = {}) =>
  call("POST", ACCOUNTS(opts.entity), { ...opts, body: { number, name } });
const deactivate = (number: string, opts: CallOptions & { entity?: string } = {}) =>
  call("POST", `${ACCOUNTS(opts.entity)}/${encodeURIComponent(number)}/deactivate`, opts);
const reactivate = (number: string, opts: CallOptions & { entity?: string } = {}) =>
  call("POST", `${ACCOUNTS(opts.entity)}/${encodeURIComponent(number)}/reactivate`, opts);
const VATS = (entity = "welld_ch") => `/v1/entities/${entity}/vat-codes`;
const addVat = (code = "IMP81", ratePercent = "8.1", label = "IVA 8.1%", opts: CallOptions & { entity?: string } = {}) =>
  call("POST", VATS(opts.entity), { ...opts, body: { code, label, ratePercent } });
const deactivateVat = (code: string, opts: CallOptions & { entity?: string } = {}) =>
  call("POST", `${VATS(opts.entity)}/${encodeURIComponent(code)}/deactivate`, opts);
const reactivateVat = (code: string, opts: CallOptions & { entity?: string } = {}) =>
  call("POST", `${VATS(opts.entity)}/${encodeURIComponent(code)}/reactivate`, opts);
const codes = (res: { body: Record<string, any> }) => (res.body["items"] as { code: string }[]).map((i) => i.code);
const numbers = (res: { body: Record<string, any> }) => (res.body["items"] as { number: string }[]).map((i) => i.number);

beforeAll(async () => {
  await truncateAccountingTables();
});
beforeEach(async () => {
  await truncateAccountingTables();
  __resetAuthzCacheForTests();
});
afterAll(async () => {
  await truncateAccountingTables();
});

describe("the harness reaches the real app (the T6 issue)", () => {
  it("answers 401 without a token and 200 with one, through ../index, in a full run as alone", async () => {
    expect((await call("GET", ACCOUNTS(), { token: false })).status).toBe(401);
    expect((await call("GET", ACCOUNTS())).status).toBe(200);
    expect((await call("GET", VATS(), { token: false })).status).toBe(401);
    expect((await call("GET", VATS())).status).toBe(200);
  });
});

describe("percent and basis-point conversion", () => {
  it("is exact, with no float", () => {
    expect(percentToBasisPoints("8.1")).toBe(810);
    expect(percentToBasisPoints("8")).toBe(800);
    expect(percentToBasisPoints("8.10")).toBe(810);
    expect(percentToBasisPoints("7.7")).toBe(770);
    expect(percentToBasisPoints("0")).toBe(0);
    expect(percentToBasisPoints("100")).toBe(10000);
    expect(percentToBasisPoints("0.07")).toBe(7);
    expect(() => percentToBasisPoints("100.01")).toThrow(RangeError);
    expect(() => percentToBasisPoints("8.123")).toThrow(RangeError);
    expect(basisPointsToPercent(810)).toBe("8.1");
    expect(basisPointsToPercent(805)).toBe("8.05");
    expect(basisPointsToPercent(0)).toBe("0");
    expect(basisPointsToPercent(10000)).toBe("100");
    expect(basisPointsToPercent(7)).toBe("0.07");
  });
});

describe("the order of account numbers", () => {
  it("compares segment by segment as whole numbers, parent before its children, at any length", () => {
    const sorted = ["5905", "2620.10", "599", "2620.9", "2620", "2620.1", "1.2.3", "1.10", "1.2", "05", "5", "0"].sort(
      compareAccountNumbers,
    );
    expect(sorted).toEqual(["0", "1.2", "1.2.3", "1.10", "05", "5", "599", "2620", "2620.1", "2620.9", "2620.10", "5905"]);
  });

  it("does not lose the digits of a 20-digit segment to a float", () => {
    const a = "12345678901234567890";
    const b = "12345678901234567891";
    expect(compareAccountNumbers(a, b)).toBeLessThan(0);
    expect(compareAccountNumbers(b, a)).toBeGreaterThan(0);
    expect(compareAccountNumbers(a, a)).toBe(0);
  });
});

describe("(AC-1.1, AC-1.13) adding an account", () => {
  it("answers 201 with number, name and active only, and lists it", async () => {
    const res = await addAccount(" 5905 ", "  Spese  ", { sub: "manager-7", email: "carla@welld.ch" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ number: "5905", name: "Spese", active: true }); // no id, no who-added, no history (D18)

    const list = await call("GET", ACCOUNTS());
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ entity: "welld_ch", items: [{ number: "5905", name: "Spese", active: true }] });
  });

  it("records the actor from the JWT, never from the body, and the entity from the path", async () => {
    const res = await call("POST", ACCOUNTS(), {
      body: { number: "5905", name: "Spese", createdByEmail: "attacker@x.com", createdByUserId: "x", entity: "welld_it", id: "mine" },
      sub: "manager-7",
      email: "carla@welld.ch",
    });
    expect(res.status).toBe(201);
    const row = await db.ledgerAccount.findFirstOrThrow();
    expect(row).toMatchObject({ number: "5905", entity: "welld_ch", createdByUserId: "manager-7", createdByEmail: "carla@welld.ch" });
    expect(row.id).not.toBe("mine");
  });

  it("lists by number, segment by segment, with a child after its parent", async () => {
    for (const number of ["5905", "599", "2620.10", "2620.1", "2620", "2620.9", "1.2.3"]) await addAccount(number, `Account ${number}`);
    expect(numbers(await call("GET", ACCOUNTS()))).toEqual(["1.2.3", "599", "2620", "2620.1", "2620.9", "2620.10", "5905"]);
  });

  it("keeps a name with accents and non-Latin letters as it is", async () => {
    const name = "Spese di rappresentanza, più IVA — 日本";
    expect((await addAccount("6101", name)).body["name"]).toBe(name);
  });

  it("(AC-8.3) lists an entity with nothing entered as an empty list, not an error", async () => {
    const res = await call("GET", ACCOUNTS("welld_it"), { as: PERSONAS.accountingIt });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entity: "welld_it", items: [] });
  });

  it("(AC-1.3) keeps the two entities apart: an account of one is not in the other's list", async () => {
    await addAccount("5905", "CH only", { as: PERSONAS.admin });
    await addAccount("1000", "IT only", { as: PERSONAS.admin, entity: "welld_it" });
    expect(numbers(await call("GET", ACCOUNTS("welld_ch"), { as: PERSONAS.admin }))).toEqual(["5905"]);
    expect(numbers(await call("GET", ACCOUNTS("welld_it"), { as: PERSONAS.admin }))).toEqual(["1000"]);
  });
});

describe("(AC-1.2) the limits of a number and a name", () => {
  const refusedNumber = async (number: unknown, reason: string) => {
    const before = await db.ledgerAccount.count();
    const res = await call("POST", ACCOUNTS(), { body: { number, name: "x" } });
    expect(res.status).toBe(422);
    expect(res.body["code"]).toBe("invalid_ledger_account");
    expect(res.body["fields"]).toEqual([{ field: "number", reason }]);
    expect(await db.ledgerAccount.count()).toBe(before);
  };

  it("accepts 5905, 2620.1, 1.2.3 and a 20-character number, and trims the blanks around it", async () => {
    for (const number of ["5905", "2620.1", "1.2.3", "1".repeat(20), "0", "007"]) {
      expect((await addAccount(number, "x")).status).toBe(201);
    }
    const trimmed = await addAccount(" \t5906\n ", "x");
    expect(trimmed.status).toBe(201);
    expect(trimmed.body["number"]).toBe("5906");
  });

  it("refuses an empty or blank number as `empty`", async () => {
    await refusedNumber("", "empty");
    await refusedNumber("   ", "empty");
    await refusedNumber(undefined, "empty");
    await refusedNumber(null, "empty");
  });

  it("refuses what is not digits separated by single dots as `format`", async () => {
    for (const bad of ["5905.", ".5", "59..05", "59a", "59 05", "-5", "+5", "5,5", "１２３", "5905.1.", "1e3"]) {
      await refusedNumber(bad, "format");
    }
    await refusedNumber(5905, "format");
    await refusedNumber(["5905"], "format");
  });

  it("refuses a number over 20 characters as `too_long`, and a long garbage value as `format`", async () => {
    await refusedNumber("1".repeat(21), "too_long");
    await refusedNumber("1.".repeat(10) + "1", "too_long");
    await refusedNumber("a".repeat(30), "format");
  });

  it("accepts a name of 120 characters and refuses 121, blanks and a missing name, naming the field", async () => {
    expect((await addAccount("6001", "n".repeat(120))).status).toBe(201);
    for (const [name, reason] of [
      ["n".repeat(121), "too_long"],
      ["   ", "empty"],
      ["", "empty"],
      [undefined, "empty"],
      [42, "format"],
    ] as const) {
      const res = await call("POST", ACCOUNTS(), { body: { number: "6002", name } });
      expect(res.status).toBe(422);
      expect(res.body["fields"]).toEqual([{ field: "name", reason }]);
    }
    expect(await db.ledgerAccount.count()).toBe(1);
  });

  it("names every refused field when both are wrong, and writes nothing", async () => {
    const res = await call("POST", ACCOUNTS(), { body: { number: "59a", name: "" } });
    expect(res.status).toBe(422);
    expect(res.body["fields"]).toEqual([
      { field: "number", reason: "format" },
      { field: "name", reason: "empty" },
    ]);
    expect(await db.ledgerAccount.count()).toBe(0);
  });

  it("refuses a body that is not an object, naming both fields", async () => {
    for (const raw of ["null", "[]", '"x"', "7"]) {
      const res = await call("POST", ACCOUNTS(), { raw });
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("invalid_ledger_account");
      expect((res.body["fields"] as { field: string }[]).map((f) => f.field)).toEqual(["number", "name"]);
    }
  });

  it("refuses a control character in a name (NUL would be a 500 from the database), as `format`", async () => {
    for (const name of ["a\u0000b", "tab\there", "line\nbreak"]) {
      const res = await call("POST", ACCOUNTS(), { body: { number: "6003", name } });
      expect(res.status).toBe(422);
      expect(res.body["fields"]).toEqual([{ field: "name", reason: "format" }]);
    }
    expect(await db.ledgerAccount.count()).toBe(0);
  });

  it("never echoes the refused value or anything of the system in the problem", async () => {
    const res = await call("POST", ACCOUNTS(), { body: { number: "SECRET-VALUE", name: "ok" } });
    expect(JSON.stringify(res.body)).not.toContain("SECRET-VALUE");
    expect(`${res.body["detail"]} ${JSON.stringify(res.body["fields"])}`).not.toMatch(/https?:|localhost|prisma|postgres|\bid\b/i);
  });

  it("answers a malformed JSON body with a client error and a body over 4 KiB with 413, saving nothing", async () => {
    const malformed = await call("POST", ACCOUNTS(), { raw: "{not json" });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
    expect((await call("POST", ACCOUNTS(), { raw: JSON.stringify({ number: "5905", name: "x".repeat(5000) }) })).status).toBe(413);
    expect(await db.ledgerAccount.count()).toBe(0);
  });
});

describe("(AC-1.3) the same number twice", () => {
  it("is a 409 naming the number, also when the first is deactivated, with `reactivate` telling which", async () => {
    await addAccount();
    const active = await addAccount("5905", "Another name");
    expect(active.status).toBe(409);
    expect(active.body).toMatchObject({ code: "ledger_account_duplicate", number: "5905", reactivate: false });
    expect(active.body["detail"]).toBe("Account 5905 already exists");

    expect((await deactivate("5905")).status).toBe(200);
    const inactive = await addAccount("5905", "Third");
    expect(inactive.status).toBe(409);
    expect(inactive.body).toMatchObject({ code: "ledger_account_duplicate", number: "5905", reactivate: true }); // G9
    expect(await db.ledgerAccount.count()).toBe(1);
    expect((await db.ledgerAccount.findFirstOrThrow()).name).toBe("Spese rimborsi chilometrici");
  });

  it("names the TRIMMED number when the duplicate was typed with blanks around it", async () => {
    await addAccount("5905");
    const dup = await addAccount("  5905 ");
    expect(dup.status).toBe(409);
    expect(dup.body["number"]).toBe("5905");
  });

  it("is accepted in the other entity", async () => {
    expect((await addAccount("5905", "CH", { as: PERSONAS.admin })).status).toBe(201);
    expect((await addAccount("5905", "IT", { as: PERSONAS.admin, entity: "welld_it" })).status).toBe(201);
    expect(await db.ledgerAccount.count()).toBe(2);
  });

  it("two concurrent adds of one number, 20 times over: exactly one 201 and one 409 each time", async () => {
    for (let i = 0; i < 20; i++) {
      const number = String(6100 + i);
      const results = await Promise.all([addAccount(number, "A"), addAccount(number, "B")]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body).toMatchObject({ code: "ledger_account_duplicate", number, reactivate: false });
    }
    expect(await db.ledgerAccount.count()).toBe(20);
  });

  it("twenty concurrent adds of one number: one 201, nineteen 409", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => addAccount("7001", `Name ${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await db.ledgerAccount.count()).toBe(1);
  });
});

describe("(AC-1.4, AC-1.9, AC-1.13) deactivating and reactivating", () => {
  it("a deactivated account stays in the list marked inactive; reactivated, it is the same account", async () => {
    await addAccount("5905", "Spese");
    const off = await deactivate("5905", { email: "off@welld.ch" });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ number: "5905", name: "Spese", active: false });
    expect((await call("GET", ACCOUNTS())).body["items"]).toEqual([{ number: "5905", name: "Spese", active: false }]);

    const on = await reactivate("5905", { email: "on@welld.ch" });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ number: "5905", name: "Spese", active: true });
    expect((await call("GET", ACCOUNTS())).body["items"]).toEqual([{ number: "5905", name: "Spese", active: true }]);
  });

  it("writes one status row per change with actor, time, entity and the after-state, each the opposite of the one before", async () => {
    await addAccount("5905", "Spese", { sub: "adder", email: "adder@welld.ch" });
    await deactivate("5905", { sub: "u-off", email: "off@welld.ch" });
    await reactivate("5905", { sub: "u-on", email: "on@welld.ch" });
    await deactivate("5905", { sub: "u-off2", email: "off2@welld.ch" });
    const rows = await db.catalogStatusChange.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(rows.map((r) => [r.active, r.createdByUserId, r.createdByEmail, r.entity])).toEqual([
      [false, "u-off", "off@welld.ch", "welld_ch"],
      [true, "u-on", "on@welld.ch", "welld_ch"],
      [false, "u-off2", "off2@welld.ch", "welld_ch"],
    ]);
    const times = rows.map((r) => r.createdAt.getTime());
    expect(new Set(times).size).toBe(3); // strictly ordered
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const account = await db.ledgerAccount.findFirstOrThrow();
    expect(rows.every((r) => r.ledgerAccountId === account.id && r.vatCodeId === null)).toBe(true);
    expect(account.createdAt.getTime()).toBeLessThanOrEqual(times[0]!);
  });

  it("records the entity of the entry on the row when the other entity is the one changed", async () => {
    await addAccount("1000", "IT", { as: PERSONAS.accountingIt, entity: "welld_it" });
    await deactivate("1000", { as: PERSONAS.accountingIt, entity: "welld_it" });
    expect((await db.catalogStatusChange.findFirstOrThrow()).entity).toBe("welld_it");
  });

  it("changes only the number asked for, and only in the entity asked for", async () => {
    await addAccount("5905", "CH", { as: PERSONAS.admin });
    await addAccount("5905", "IT", { as: PERSONAS.admin, entity: "welld_it" });
    await addAccount("5906", "CH2", { as: PERSONAS.admin });
    await deactivate("5905", { as: PERSONAS.admin });
    const ch = await call("GET", ACCOUNTS("welld_ch"), { as: PERSONAS.admin });
    const it = await call("GET", ACCOUNTS("welld_it"), { as: PERSONAS.admin });
    expect(ch.body["items"]).toEqual([
      { number: "5905", name: "CH", active: false },
      { number: "5906", name: "CH2", active: true },
    ]);
    expect(it.body["items"]).toEqual([{ number: "5905", name: "IT", active: true }]);
  });

  it("finds a number with a dot, and an unknown one is a 404 `not_found` that writes nothing", async () => {
    await addAccount("2620.1", "Dotted");
    expect((await deactivate("2620.1")).status).toBe(200);
    const unknown = await deactivate("9999");
    expect(unknown.status).toBe(404);
    expect(unknown.body["code"]).toBe("not_found");
    expect((await reactivate("9999")).status).toBe(404);
    expect(await db.catalogStatusChange.count()).toBe(1);
  });
});

describe("(AC-1.11) an entry already in the state asked for", () => {
  it("reactivating an active account, or deactivating an inactive one, is a 409 with its message that writes no row", async () => {
    await addAccount();
    const again = await reactivate("5905");
    expect(again.status).toBe(409);
    expect(again.body["code"]).toBe("already_active");
    expect(again.body["detail"]).toBe("Account 5905 is already active");
    expect(await db.catalogStatusChange.count()).toBe(0);

    await deactivate("5905");
    const twice = await deactivate("5905");
    expect(twice.status).toBe(409);
    expect(twice.body["code"]).toBe("already_inactive");
    expect(twice.body["detail"]).toBe("Account 5905 is already inactive");
    expect(await db.catalogStatusChange.count()).toBe(1);
  });

  it("twenty concurrent deactivations: exactly one 200, nineteen 409, one status row", async () => {
    await addAccount();
    const results = await Promise.all(Array.from({ length: 20 }, () => deactivate("5905")));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(results.filter((r) => r.status === 409).every((r) => r.body["code"] === "already_inactive")).toBe(true);
    expect(await db.catalogStatusChange.count()).toBe(1);
  });

  it("twenty concurrent reactivations of an inactive account: exactly one wins", async () => {
    await addAccount();
    await deactivate("5905");
    const results = await Promise.all(Array.from({ length: 20 }, () => reactivate("5905")));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(await db.catalogStatusChange.count()).toBe(2);
    expect((await call("GET", ACCOUNTS())).body["items"][0].active).toBe(true);
  });

  it("alternating deactivate and reactivate from several callers at once keeps the history consistent", async () => {
    await addAccount();
    const calls = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? deactivate("5905") : reactivate("5905")));
    await Promise.all(calls);
    const rows = await db.catalogStatusChange.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    // Whatever order the lock gave them, every row flips the state before it: no two in a row alike.
    rows.forEach((row, i) => expect(row.active).toBe(i % 2 === 0 ? false : true));
    const current = (await call("GET", ACCOUNTS())).body["items"][0].active as boolean;
    expect(current).toBe(rows.length === 0 ? true : rows[rows.length - 1]!.active);
  });
});

describe("(AC-1.12) there is no way to change or delete an entry", () => {
  it("the OpenAPI document lists the catalog routes, and no write method but the six POSTs", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const paths = ((await res.json()) as { paths: Record<string, Record<string, unknown>> }).paths;
    // The exchange-rates routes (T12) are the one entity-scoped surface that has a PUT: their own tests prove them.
    const catalog = Object.entries(paths).filter(([path]) => path.startsWith("/v1/entities/") && !path.includes("/exchange-rates"));
    expect(catalog.map(([path]) => path).sort()).toEqual([
      "/v1/entities/{entity}/ledger-accounts",
      "/v1/entities/{entity}/ledger-accounts/{number}/deactivate",
      "/v1/entities/{entity}/ledger-accounts/{number}/reactivate",
      "/v1/entities/{entity}/vat-codes",
      "/v1/entities/{entity}/vat-codes/{code}/deactivate",
      "/v1/entities/{entity}/vat-codes/{code}/reactivate",
    ]);
    const methods = catalog.flatMap(([, ops]) => Object.keys(ops));
    expect(methods.sort()).toEqual(["get", "get", "post", "post", "post", "post", "post", "post"]);
  });

  it("PUT, PATCH and DELETE answer 404 on the list, an entry and its actions, for a manager", async () => {
    await addAccount();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      for (const path of [ACCOUNTS(), `${ACCOUNTS()}/5905`, `${ACCOUNTS()}/5905/deactivate`, `${ACCOUNTS()}/5905/reactivate`]) {
        const res = await call(method, path, { body: { name: "renamed", number: "1" } });
        expect(res.status).toBe(404);
      }
    }
    const row = await db.ledgerAccount.findFirstOrThrow();
    expect(row).toMatchObject({ number: "5905", name: "Spese rimborsi chilometrici" });
    expect(await db.catalogStatusChange.count()).toBe(0);
  });

  it("a method with no route is not a way to learn anything: a reader and an outsider get the same 404", async () => {
    await addAccount();
    for (const as of [PERSONAS.readerCh, PERSONAS.outsider]) {
      expect((await call("DELETE", `${ACCOUNTS()}/5905`, { as })).status).toBe(404);
      expect((await call("PUT", ACCOUNTS(), { as, body: {} })).status).toBe(404);
    }
    expect((await call("DELETE", `${ACCOUNTS()}/5905`, { token: false })).status).toBe(401);
  });
});

describe("(AC-3.4) a reader writes nothing", () => {
  it("add, deactivate and reactivate are 403 `accounting_manage_required`, before the body is looked at", async () => {
    await addAccount();
    for (const as of [PERSONAS.readerCh]) {
      for (const res of [
        await call("POST", ACCOUNTS(), { as, body: { number: "6101", name: "x" } }),
        await call("POST", ACCOUNTS(), { as, body: {} }),
        await call("POST", ACCOUNTS(), { as, raw: "{not json" }),
        await deactivate("5905", { as }),
        await reactivate("5905", { as }),
        await deactivate("9999", { as }), // a reader does not even learn whether an entry exists
      ]) {
        expect(res.status).toBe(403);
        expect(res.body["code"]).toBe("accounting_manage_required");
      }
    }
    expect(await db.ledgerAccount.count()).toBe(1);
    expect(await db.catalogStatusChange.count()).toBe(0);
  });

  it("a reader can list, and so can a holder of manage alone (manage covers read, AC-3.2)", async () => {
    await addAccount();
    for (const as of [PERSONAS.readerCh, PERSONAS.managerOnlyCh]) {
      const res = await call("GET", ACCOUNTS(), { as });
      expect(res.status).toBe(200);
      expect(numbers(res)).toEqual(["5905"]);
    }
  });

  it("a holder of manage alone can write", async () => {
    expect((await addAccount("6101", "x", { as: PERSONAS.managerOnlyCh })).status).toBe(201);
    expect((await deactivate("6101", { as: PERSONAS.managerOnlyCh })).status).toBe(200);
  });

  it("no token is 401 on every route", async () => {
    for (const [method, path] of [
      ["GET", ACCOUNTS()],
      ["POST", ACCOUNTS()],
      ["POST", `${ACCOUNTS()}/5905/deactivate`],
      ["POST", `${ACCOUNTS()}/5905/reactivate`],
    ] as const) {
      expect((await call(method, path, { token: false, body: {} })).status).toBe(401);
    }
  });
});

describe("(AC-3.5) an entity outside the caller's coverage is not found", () => {
  const stripInstance = (body: Record<string, any>) => {
    const { instance: _instance, ...rest } = body;
    return rest;
  };

  it("every route of welld_it answers a welld_ch user 404, with the body of an entity that does not exist, and touches nothing", async () => {
    const it = await db.ledgerAccount.create({
      data: { entity: "welld_it", number: "1000", name: "IT", createdByUserId: "seed", createdByEmail: "seed@welld.ch" },
    });
    const unknownEntity = await call("GET", ACCOUNTS("xyz"));
    expect(unknownEntity.status).toBe(404);
    for (const [method, path, body] of [
      ["GET", ACCOUNTS("welld_it"), undefined],
      ["POST", ACCOUNTS("welld_it"), { number: "2000", name: "new" }],
      ["POST", `${ACCOUNTS("welld_it")}/1000/deactivate`, undefined],
      ["POST", `${ACCOUNTS("welld_it")}/1000/reactivate`, undefined],
      ["POST", `${ACCOUNTS("welld_it")}/9999/deactivate`, undefined],
    ] as const) {
      const res = await call(method, path, body === undefined ? {} : { body });
      expect(res.status).toBe(404);
      expect(stripInstance(res.body)).toEqual(stripInstance(unknownEntity.body));
    }
    expect(await db.ledgerAccount.count()).toBe(1);
    expect(await db.catalogStatusChange.count()).toBe(0);
    expect(it.id).toBeTruthy();
  });

  it("an unknown entity is the same 404 for every method that has a route, and nothing of its list leaks", async () => {
    for (const entity of ["xyz", "WELLD_CH", "welld_ch ", "__proto__", "constructor"]) {
      const res = await call("GET", ACCOUNTS(encodeURIComponent(entity)));
      expect(res.status).toBe(404);
      expect(res.body["code"]).toBe("not_found");
      expect(res.body["items"]).toBeUndefined();
    }
  });

  it("an admin, whose grants are unconditioned, covers both entities", async () => {
    expect((await call("GET", ACCOUNTS("welld_ch"), { as: PERSONAS.admin })).status).toBe(200);
    expect((await call("GET", ACCOUNTS("welld_it"), { as: PERSONAS.admin })).status).toBe(200);
  });

  it("a welld_it user reads and manages welld_it and is refused welld_ch the same way", async () => {
    expect((await addAccount("1000", "IT", { as: PERSONAS.accountingIt, entity: "welld_it" })).status).toBe(201);
    expect((await call("GET", ACCOUNTS("welld_ch"), { as: PERSONAS.accountingIt })).status).toBe(404);
  });
});

describe("(AC-3.6) a caller with no Accounting grant gets no data", () => {
  it("is 403 `accounting_forbidden` on every route, whatever the entity, with nothing of the lists in the body", async () => {
    await addAccount("5905", "VISIBLE-NAME", { as: PERSONAS.admin });
    for (const as of [PERSONAS.outsider, PERSONAS.noEntity, PERSONAS.unknownCondition]) {
      for (const [method, path, body] of [
        ["GET", ACCOUNTS("welld_ch"), undefined],
        ["GET", ACCOUNTS("welld_it"), undefined],
        ["GET", ACCOUNTS("xyz"), undefined],
        ["POST", ACCOUNTS("welld_ch"), { number: "6101", name: "x" }],
        ["POST", `${ACCOUNTS("welld_ch")}/5905/deactivate`, undefined],
        ["POST", `${ACCOUNTS("welld_ch")}/5905/reactivate`, undefined],
      ] as const) {
        const res = await call(method, path, { as, ...(body ? { body } : {}) });
        expect(res.status).toBe(403);
        expect(res.body["code"]).toBe("accounting_forbidden");
        const { instance: _instance, ...data } = res.body; // `instance` echoes the path asked
        expect(JSON.stringify(data)).not.toContain("VISIBLE-NAME");
        expect(JSON.stringify(data)).not.toContain("5905");
        expect(data["items"]).toBeUndefined();
      }
    }
    expect(await db.ledgerAccount.count()).toBe(1);
    expect(await db.catalogStatusChange.count()).toBe(0);
  });
});


// ─── VAT codes (T9) ──────────────────────────────────────────────────────────

describe("(AC-1.5) adding a VAT code", () => {
  it("answers 201 with code, label, ratePercent, rateBasisPoints and active only, upper-cased, and lists it", async () => {
    const res = await addVat("imp81", "8.1", "  IVA 8.1%  ", { sub: "manager-7", email: "carla@welld.ch" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", rateBasisPoints: 810, active: true });
    const list = await call("GET", VATS());
    expect(list.body).toEqual({
      entity: "welld_ch",
      items: [{ code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", rateBasisPoints: 810, active: true }],
    });
    const row = await db.vatCode.findFirstOrThrow();
    expect(row).toMatchObject({ entity: "welld_ch", createdByUserId: "manager-7", createdByEmail: "carla@welld.ch", rateBasisPoints: 810 });
  });

  it("stores the rate in basis points, exactly: 8.1 is 810, 8 is 800, 7.70 is 770, 0.07 is 7, 0 and 100 are the bounds", async () => {
    const rows: [string, string, number, string][] = [
      ["A", "8.1", 810, "8.1"],
      ["B", "8", 800, "8"],
      ["C", "7.70", 770, "7.7"],
      ["D", "0.07", 7, "0.07"],
      ["E", "0", 0, "0"],
      ["F", "100", 10000, "100"],
      ["G", "100.00", 10000, "100"],
      ["H", "2.5", 250, "2.5"],
    ];
    for (const [code, rate, bp, shown] of rows) {
      const res = await addVat(code, rate, `Label ${code}`);
      expect(res.status).toBe(201);
      expect(res.body["rateBasisPoints"]).toBe(bp);
      expect(res.body["ratePercent"]).toBe(shown);
    }
  });

  const refused = async (body: Record<string, unknown>, fields: { field: string; reason: string }[]) => {
    const before = await db.vatCode.count();
    const res = await call("POST", VATS(), { body });
    expect(res.status).toBe(422);
    expect(res.body["code"]).toBe("invalid_vat_code");
    expect(res.body["fields"]).toEqual(fields);
    expect(await db.vatCode.count()).toBe(before);
  };

  it("refuses a rate of -1, 100.01, 8.123 and a non-number, naming ratePercent, and saves nothing", async () => {
    await refused({ code: "BAD", label: "l", ratePercent: "-1" }, [{ field: "ratePercent", reason: "format" }]);
    await refused({ code: "BAD", label: "l", ratePercent: "100.01" }, [{ field: "ratePercent", reason: "range" }]);
    await refused({ code: "BAD", label: "l", ratePercent: "8.123" }, [{ field: "ratePercent", reason: "format" }]);
    for (const ratePercent of ["abc", "1e2", ".5", "1000", "8,1", "+8"]) {
      await refused({ code: "BAD", label: "l", ratePercent }, [{ field: "ratePercent", reason: "format" }]);
    }
    await refused({ code: "BAD", label: "l", ratePercent: "" }, [{ field: "ratePercent", reason: "empty" }]);
    await refused({ code: "BAD", label: "l" }, [{ field: "ratePercent", reason: "empty" }]);
    await refused({ code: "BAD", label: "l", ratePercent: 8.1 }, [{ field: "ratePercent", reason: "format" }]);
  });

  it("refuses a code with a space or 17 characters, and a label of 0 or 81 characters, naming each field", async () => {
    await refused({ code: "IMP 81", label: "l", ratePercent: "8" }, [{ field: "code", reason: "format" }]);
    await refused({ code: "A".repeat(17), label: "l", ratePercent: "8" }, [{ field: "code", reason: "too_long" }]);
    await refused({ code: "a".repeat(17), label: "l", ratePercent: "8" }, [{ field: "code", reason: "too_long" }]);
    await refused({ code: "", label: "l", ratePercent: "8" }, [{ field: "code", reason: "empty" }]);
    await refused({ code: "ü", label: "l", ratePercent: "8" }, [{ field: "code", reason: "format" }]);
    await refused({ code: "OK", label: "", ratePercent: "8" }, [{ field: "label", reason: "empty" }]);
    await refused({ code: "OK", label: "l".repeat(81), ratePercent: "8" }, [{ field: "label", reason: "too_long" }]);
    await refused({ code: "OK", label: "a\u0000b", ratePercent: "8" }, [{ field: "label", reason: "format" }]);
    await refused({ code: "bad code", label: "", ratePercent: "x" }, [
      { field: "code", reason: "format" },
      { field: "label", reason: "empty" },
      { field: "ratePercent", reason: "format" },
    ]);
  });

  it("accepts a 16-character code, an 80-character label, and the code's `_` and `-`", async () => {
    expect((await addVat("a".repeat(16), "8", "l".repeat(80))).status).toBe(201);
    expect((await addVat("imp_81-x", "8")).body["code"]).toBe("IMP_81-X");
  });

  it("(AC-8.3) lists an entity with nothing entered as an empty list", async () => {
    const res = await call("GET", VATS("welld_it"), { as: PERSONAS.accountingIt });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entity: "welld_it", items: [] });
  });

  it("lists in code order", async () => {
    for (const code of ["IMP81", "A1", "EXP0", "9Z"]) await addVat(code);
    expect(codes(await call("GET", VATS()))).toEqual(["9Z", "A1", "EXP0", "IMP81"]);
  });
});

describe("(AC-1.6) the same VAT code twice", () => {
  it("is a 409 naming the code, `imp81` against `IMP81`, active (reactivate false) or deactivated (reactivate true)", async () => {
    await addVat("IMP81");
    const active = await addVat("imp81", "7.7", "other");
    expect(active.status).toBe(409);
    expect(active.body).toMatchObject({ code: "vat_code_duplicate", vatCode: "IMP81", reactivate: false });
    expect(active.body["detail"]).toBe("VAT code IMP81 already exists");

    await deactivateVat("IMP81");
    const inactive = await addVat("Imp81");
    expect(inactive.status).toBe(409);
    expect(inactive.body).toMatchObject({ code: "vat_code_duplicate", vatCode: "IMP81", reactivate: true }); // G9
    expect(await db.vatCode.count()).toBe(1);
    expect((await db.vatCode.findFirstOrThrow()).rateBasisPoints).toBe(810);
  });

  it("is accepted in the other entity", async () => {
    expect((await addVat("IMP81", "8.1", "CH", { as: PERSONAS.admin })).status).toBe(201);
    expect((await addVat("imp81", "22", "IT", { as: PERSONAS.admin, entity: "welld_it" })).status).toBe(201);
    expect(await db.vatCode.count()).toBe(2);
  });

  it("two concurrent adds of one code in two spellings, 20 times over: one 201 and one 409 each time", async () => {
    for (let i = 0; i < 20; i++) {
      const code = `RACE${i}`;
      const results = await Promise.all([addVat(code, "8"), addVat(code.toLowerCase(), "9")]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({ code: "vat_code_duplicate", vatCode: code, reactivate: false });
    }
    expect(await db.vatCode.count()).toBe(20);
  });

  it("twenty concurrent adds of one code: one 201, nineteen 409", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => addVat("RACE", "8")));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(await db.vatCode.count()).toBe(1);
  });
});

describe("(AC-1.7) there is no way to change a VAT code's rate", () => {
  it("PUT and PATCH on the code, in any case, answer 404, and the rate is unchanged", async () => {
    await addVat("IMP81", "8.1");
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      for (const path of [VATS(), `${VATS()}/IMP81`, `${VATS()}/imp81`, `${VATS()}/IMP81/deactivate`, `${VATS()}/IMP81/reactivate`]) {
        const res = await call(method, path, { body: { ratePercent: "9", label: "x", code: "NEW" } });
        expect(res.status).toBe(404);
      }
    }
    expect(await db.vatCode.findFirstOrThrow()).toMatchObject({ code: "IMP81", rateBasisPoints: 810, label: "IVA 8.1%" });
    expect(await db.catalogStatusChange.count()).toBe(0);
  });

  it("a request body cannot carry a rate onto an existing code: the duplicate is refused and the rate stays", async () => {
    await addVat("IMP81", "8.1");
    const res = await addVat("IMP81", "9.9");
    expect(res.status).toBe(409);
    expect((await db.vatCode.findFirstOrThrow()).rateBasisPoints).toBe(810);
  });

  it("the database refuses a raw UPDATE of the rate and of the entity (the wall behind the routes)", async () => {
    await addVat("IMP81", "8.1");
    expect((await violation(db.$executeRaw`UPDATE "vat_code" SET "rateBasisPoints" = 900`)).code).toBe(SQLSTATE.raise);
    expect((await violation(db.$executeRaw`UPDATE "vat_code" SET "entity" = 'welld_it'::"Entity"`)).code).toBe(SQLSTATE.raise);
    expect((await db.vatCode.findFirstOrThrow()).rateBasisPoints).toBe(810);
  });
});

describe("(AC-1.8, AC-1.10, AC-1.13) deactivating and reactivating a VAT code", () => {
  it("a deactivated code stays listed, inactive; reactivated it has the same code, label and rate", async () => {
    await addVat("IMP81", "8.1", "IVA 8.1%");
    const off = await deactivateVat("imp81", { email: "off@welld.ch" }); // {code} is upper-cased before the lookup
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", rateBasisPoints: 810, active: false });
    expect((await call("GET", VATS())).body["items"][0].active).toBe(false);

    const on = await reactivateVat("Imp81", { email: "on@welld.ch" });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ code: "IMP81", label: "IVA 8.1%", ratePercent: "8.1", rateBasisPoints: 810, active: true });
  });

  it("writes one status row per change with actor, time, entity and the after-state", async () => {
    await addVat("IMP81");
    await deactivateVat("IMP81", { sub: "u-off", email: "off@welld.ch" });
    await reactivateVat("IMP81", { sub: "u-on", email: "on@welld.ch" });
    const rows = await db.catalogStatusChange.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(rows.map((r) => [r.active, r.createdByUserId, r.createdByEmail, r.entity])).toEqual([
      [false, "u-off", "off@welld.ch", "welld_ch"],
      [true, "u-on", "on@welld.ch", "welld_ch"],
    ]);
    const vat = await db.vatCode.findFirstOrThrow();
    expect(rows.every((r) => r.vatCodeId === vat.id && r.ledgerAccountId === null)).toBe(true);
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(2);
  });

  it("changes only the code asked for, in the entity asked for, and not an account that has the same text", async () => {
    await addVat("5905", "8", "CH", { as: PERSONAS.admin });
    await addVat("5905", "8", "IT", { as: PERSONAS.admin, entity: "welld_it" });
    await addAccount("5905", "An account", { as: PERSONAS.admin });
    await deactivateVat("5905", { as: PERSONAS.admin });
    expect((await call("GET", VATS("welld_ch"), { as: PERSONAS.admin })).body["items"][0].active).toBe(false);
    expect((await call("GET", VATS("welld_it"), { as: PERSONAS.admin })).body["items"][0].active).toBe(true);
    expect((await call("GET", ACCOUNTS("welld_ch"), { as: PERSONAS.admin })).body["items"][0].active).toBe(true);
  });

  it("an unknown code, or a ledger account's number on the VAT route, is a 404 `not_found` that writes nothing", async () => {
    await addAccount("5905");
    const unknown = await deactivateVat("NOPE");
    expect(unknown.status).toBe(404);
    expect(unknown.body["code"]).toBe("not_found");
    expect((await reactivateVat("NOPE")).status).toBe(404);
    expect((await deactivateVat("5905")).status).toBe(404);
    expect(await db.catalogStatusChange.count()).toBe(0);
  });
});

describe("(AC-1.11) a VAT code already in the state asked for", () => {
  it("is a 409 with its message that writes no row", async () => {
    await addVat("IMP81");
    const again = await reactivateVat("IMP81");
    expect(again.status).toBe(409);
    expect(again.body["code"]).toBe("already_active");
    expect(again.body["detail"]).toBe("VAT code IMP81 is already active");
    expect(await db.catalogStatusChange.count()).toBe(0);
    await deactivateVat("IMP81");
    const twice = await deactivateVat("imp81");
    expect(twice.status).toBe(409);
    expect(twice.body["code"]).toBe("already_inactive");
    expect(twice.body["detail"]).toBe("VAT code IMP81 is already inactive");
    expect(await db.catalogStatusChange.count()).toBe(1);
  });

  it("twenty concurrent deactivations: exactly one 200, nineteen 409, one status row", async () => {
    await addVat("IMP81");
    const results = await Promise.all(Array.from({ length: 20 }, () => deactivateVat("IMP81")));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(await db.catalogStatusChange.count()).toBe(1);
  });

  it("twenty concurrent reactivations of a deactivated code: exactly one wins", async () => {
    await addVat("IMP81");
    await deactivateVat("IMP81");
    const results = await Promise.all(Array.from({ length: 20 }, () => reactivateVat("IMP81")));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.catalogStatusChange.count()).toBe(2);
  });
});

describe("(AC-3.4, AC-3.5, AC-3.6) who may do what with VAT codes", () => {
  it("a reader gets 403 `accounting_manage_required` for add, deactivate and reactivate, before the body is looked at, and writes nothing", async () => {
    await addVat("IMP81");
    const as = PERSONAS.readerCh;
    for (const res of [
      await call("POST", VATS(), { as, body: { code: "NEW", label: "l", ratePercent: "8" } }),
      await call("POST", VATS(), { as, body: {} }),
      await deactivateVat("IMP81", { as }),
      await reactivateVat("IMP81", { as }),
      await deactivateVat("NOPE", { as }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body["code"]).toBe("accounting_manage_required");
    }
    expect(await db.vatCode.count()).toBe(1);
    expect(await db.catalogStatusChange.count()).toBe(0);
    for (const reads of [PERSONAS.readerCh, PERSONAS.managerOnlyCh]) {
      expect(codes(await call("GET", VATS(), { as: reads }))).toEqual(["IMP81"]);
    }
  });

  it("welld_it is not found for a welld_ch user, with the body of an entity that does not exist, and nothing is touched", async () => {
    await db.vatCode.create({
      data: { entity: "welld_it", code: "ITA22", label: "IT", rateBasisPoints: 2200, createdByUserId: "seed", createdByEmail: "s@welld.ch" },
    });
    const { instance: _i, ...unknown } = (await call("GET", VATS("xyz"))).body;
    for (const [method, path, body] of [
      ["GET", VATS("welld_it"), undefined],
      ["POST", VATS("welld_it"), { code: "NEW", label: "l", ratePercent: "8" }],
      ["POST", `${VATS("welld_it")}/ITA22/deactivate`, undefined],
      ["POST", `${VATS("welld_it")}/ITA22/reactivate`, undefined],
    ] as const) {
      const res = await call(method, path, body === undefined ? {} : { body });
      expect(res.status).toBe(404);
      const { instance: _instance, ...rest } = res.body;
      expect(rest).toEqual(unknown);
    }
    expect(await db.vatCode.count()).toBe(1);
    expect(await db.catalogStatusChange.count()).toBe(0);
  });

  it("a caller with no grant gets 403 `accounting_forbidden` and no data on every VAT route", async () => {
    await addVat("IMP81", "8.1", "VISIBLE-LABEL", { as: PERSONAS.admin });
    for (const as of [PERSONAS.outsider, PERSONAS.noEntity, PERSONAS.unknownCondition]) {
      for (const [method, path, body] of [
        ["GET", VATS("welld_ch"), undefined],
        ["GET", VATS("xyz"), undefined],
        ["POST", VATS("welld_ch"), { code: "NEW", label: "l", ratePercent: "8" }],
        ["POST", `${VATS("welld_ch")}/IMP81/deactivate`, undefined],
        ["POST", `${VATS("welld_ch")}/IMP81/reactivate`, undefined],
      ] as const) {
        const res = await call(method, path, { as, ...(body ? { body } : {}) });
        expect(res.status).toBe(403);
        expect(res.body["code"]).toBe("accounting_forbidden");
        const { instance: _instance, ...data } = res.body;
        expect(JSON.stringify(data)).not.toMatch(/VISIBLE-LABEL|IMP81|810/);
      }
    }
    expect(await db.catalogStatusChange.count()).toBe(0);
  });

  it("no token is 401 on every VAT route", async () => {
    for (const [method, path] of [
      ["GET", VATS()],
      ["POST", VATS()],
      ["POST", `${VATS()}/IMP81/deactivate`],
      ["POST", `${VATS()}/IMP81/reactivate`],
    ] as const) {
      expect((await call(method, path, { token: false, body: {} })).status).toBe(401);
    }
  });
});
