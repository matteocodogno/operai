/**
 * Save and restore of the legal-entity registry (T8; AC-1.2 to AC-1.5, AC-2.1, AC-2.4 to AC-2.6, AC-4.2; plan "Save",
 * "Restore", amendments D4, E1, E5) against REAL Postgres.
 *
 * Two kinds of test, because `legal_entity_version` is append-only (nothing can clean it):
 *   - almost every test runs in ONE rolled-back transaction (`inRolledBackTx`): the router is built with an `audited`
 *     seam that runs `mutate` and the audit rows inside that transaction, so nothing is ever committed. Users, roles
 *     and grants are ordinary committed rows with a per-run suffix, removed in `afterAll`;
 *   - the "real transactions" group needs REAL commits (concurrency, the lock, a rollback after the insert): it runs
 *     only against a registry with NO version at all (a fresh test database), seeds one committed version and, in
 *     `afterAll`, removes every row it knows is its own - all of them, since the table was empty. Against a database that
 *     already holds a registry, or against a database whose host is not local (T53, F4: `isLocalDatabaseHost`), it is
 *     skipped, loudly, and touches nothing.
 *
 * Only `auth.config` (the session source) is mocked.
 */

import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withAudit } from "../authz/audit";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import type { LegalEntity } from "./entities";
import {
  committedTransactionsSkipReason,
  committedVersionCount,
  inRolledBackTx,
  insertSql,
  isLocalDatabaseHost,
  type Tx,
  validImportRow,
} from "./testDb";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;

mock.module("../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession) } },
}));

const { createLegalEntityRateLimits, createLegalEntityWriteRouter: createThrottledWriteRouter, MAX_WRITE_BODY_BYTES, TOO_MANY_REQUESTS_BODY, INVALID_REQUEST_BODY, NOT_MOVED_BODY, REQUEST_TOO_LARGE_BODY } =
  await import("./write.routes");
const { createLegalEntityHistoryRouter, FORBIDDEN_BODY, VERSION_NOT_FOUND_BODY } = await import("./history.routes");
const { UNKNOWN_LEGAL_ENTITY_BODY } = await import("./read.routes");
const { lockEntity, lockKey } = await import("./repo");
type Audited = typeof withAudit;

/**
 * Most tests send far more than ten writes as one person: they get a router whose limits are out of the way. The
 * throttle has its own group below, built on the env's real limits.
 */
const createLegalEntityWriteRouter = (options: Parameters<typeof createThrottledWriteRouter>[0] = {}) =>
  createThrottledWriteRouter({ limits: createLegalEntityRateLimits({ writeLimit: 1_000_000, checkLimit: 1_000_000 }), ...options });

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();

async function makeUser(label: string, entity: string | null = null) {
  const user = await db.user.create({
    data: { name: `T8 fixture ${label}`, email: `t8-le-write-${label}-${RUN_ID}-${crypto.randomUUID()}@legalentities.test`, entity },
  });
  createdUserIds.add(user.id);
  return user;
}

async function grantManage(userId: string, conditions: Record<string, unknown> | null) {
  const role = await db.role.create({ data: { name: `t8-le-write-${RUN_ID}-${crypto.randomUUID()}` } });
  createdRoleIds.add(role.id);
  await db.permissionRule.create({
    data: {
      roleId: role.id,
      resource: "legal-entity",
      action: "manage",
      ...(conditions === null ? {} : { conditions: conditions as Prisma.InputJsonValue }),
    },
  });
  await db.userRole.create({ data: { userId, roleId: role.id } });
}

/** The seed's grant: unconditioned, both entities. */
async function admin(label: string) {
  const user = await makeUser(label, null);
  await grantManage(user.id, null);
  return user;
}

/** A welld_ch-only manager: the entity-conditioned grant. */
async function chManager(label: string) {
  const user = await makeUser(label, "welld_ch");
  await grantManage(user.id, { attributes: [{ key: "entity", match: "user" }] });
  return user;
}

function signedInAs(user: { id: string; email: string; name: string } | null) {
  currentSession = user === null ? null : { user, session: { id: `sess-${user.id}` } };
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { actorUserId: { in: Array.from(createdUserIds) } } });
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

// ─── Harness for the rolled-back tests ────────────────────────────────────────────────────────────────────────────

/** `withAudit`'s contract (mutation, then its audit rows, all or nothing) inside the test's own transaction. */
function auditedIn(tx: Tx): Audited {
  return (async ({ mutate, entry }) => {
    await tx.$executeRawUnsafe("SAVEPOINT le_write");
    try {
      const result = await mutate(tx);
      const resolved = typeof entry === "function" ? entry(result) : entry;
      for (const e of Array.isArray(resolved) ? resolved : [resolved]) {
        await tx.auditLog.create({
          data: {
            actorUserId: e.actorUserId,
            action: e.action,
            targetType: e.targetType,
            targetId: e.targetId ?? null,
            summary: e.summary,
            ...(e.data != null ? { data: e.data } : {}),
          },
        });
      }
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT le_write");
      return result;
    } catch (error) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT le_write");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT le_write");
      throw error;
    }
  }) as Audited;
}

const writeRouter = (tx: Tx, audited: Audited = auditedIn(tx)) => createLegalEntityWriteRouter({ audited, client: tx });

/**
 * A registry with no version, whatever was committed before: removed inside the rolled-back transaction only. The notice
 * rows go first (T58/T59: they name versions by a foreign key, and with the triggers off a version could be deleted
 * from under them, leaving orphans).
 */
async function emptyRegistry(tx: Tx): Promise<void> {
  if ((await tx.legalEntityVersion.count()) === 0) return;
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
  await tx.$executeRawUnsafe("DELETE FROM legal_entity_notice");
  await tx.$executeRawUnsafe("DELETE FROM legal_entity_version");
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
}

const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  inRolledBackTx(async (tx) => {
    await emptyRegistry(tx);
    return fn(tx);
  });

interface Seed {
  entity: LegalEntity;
  version: number;
  action?: "import" | "save" | "restore";
  restoredFrom?: number | null;
  changedFields?: string[];
  legalName?: string;
  addressIt?: string[];
  addressEn?: string[];
  vatNumber?: string;
  iban?: string;
  contactsIt?: string;
  contactsEn?: string;
}

async function seed(tx: Tx, s: Seed) {
  const action = s.action ?? (s.version === 1 ? "import" : "save");
  const by = action === "import" ? null : { id: "u-seeded", name: "Sara Seeded" };
  await tx.$executeRaw`
    INSERT INTO legal_entity_version
      ("entity","version","legalName","addressIt","addressEn","vatNumber","iban","contactsIt","contactsEn",
       "action","restoredFrom","changedFields","createdByUserId","createdByName","createdAt")
    VALUES (${s.entity}, ${s.version}, ${s.legalName ?? ""}, ${s.addressIt ?? []}::text[], ${s.addressEn ?? []}::text[],
       ${s.vatNumber ?? ""}, ${s.iban ?? ""}, ${s.contactsIt ?? ""}, ${s.contactsEn ?? ""}, ${action},
       ${s.restoredFrom ?? null}, ${s.changedFields ?? []}::text[], ${by?.id ?? null}, ${by?.name ?? null},
       ${new Date("2026-11-10T10:00:00.000Z")})`;
}

const GOOD = {
  legalName: "wellD SA",
  addressIt: ["Via Cantonale 1", "6900 Lugano"],
  addressEn: ["Via Cantonale 1", "6900 Lugano, Switzerland"],
  vatNumber: "CHE-123.456.789 IVA",
  iban: "CH9300762011623852957",
};

/**
 * v1 import without VAT or English address (not restorable), v2 a complete save, v3 and v4 saves that move the name and
 * the contacts away from v2.
 */
async function seedHistory(tx: Tx, entity: LegalEntity = "welld_ch") {
  await seed(tx, { entity, version: 1, legalName: "wellD SA", addressIt: ["Via Cantonale 1"], changedFields: ["legalName", "address.it"] });
  await seed(tx, { entity, version: 2, ...GOOD, changedFields: ["address.en", "vatNumber", "iban"] });
  await seed(tx, { entity, version: 3, ...GOOD, legalName: "wellD SA (v3)", changedFields: ["legalName"] });
  await seed(tx, { entity, version: 4, ...GOOD, legalName: "wellD SA (v4)", contactsIt: "Tel. +41 91 000 00 00", changedFields: ["legalName", "contacts.it"] });
}

const DETAILS = {
  legalName: "wellD SA",
  address: { it: ["Via Cantonale 1", "6900 Lugano"], en: ["Via Cantonale 1", "6900 Lugano, Switzerland"] },
  vatNumber: "CHE-123.456.789 IVA",
  iban: "CH9300762011623852957",
  contacts: { it: "", en: "" },
};
const details = (over: Record<string, unknown> = {}) => ({ ...DETAILS, ...over });

/** What the helpers need of a router. */
type Requestable = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

const JSON_HEADERS = { "Content-Type": "application/json" };

function post(router: Requestable, path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) {
  return router.request(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const save = (router: Requestable, entity: string, body: unknown) => post(router, `/legal-entities/${entity}/versions`, body);
const restore = (router: Requestable, entity: string, n: string | number, body: unknown) =>
  post(router, `/legal-entities/${entity}/versions/${n}/restore`, body);

const countVersions = (tx: Tx, entity: LegalEntity) => tx.legalEntityVersion.count({ where: { entity } });
const countAudit = (tx: Tx, entity: LegalEntity) => tx.auditLog.count({ where: { targetType: "legal_entity", targetId: entity } });

async function snapshot(tx: Tx) {
  return {
    versions: await tx.legalEntityVersion.findMany({ orderBy: [{ entity: "asc" }, { version: "asc" }] }),
    audit: await countAudit(tx, "welld_ch"),
    auditIt: await countAudit(tx, "welld_it"),
  };
}

// ─── Authentication and authorisation ─────────────────────────────────────────────────────────────────────────────

describe("authentication and authorisation (AC-4.2)", () => {
  test("no session: 401 on both routes, no-store, nothing written", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const before = await snapshot(tx);
      signedInAs(null);
      const router = writeRouter(tx);
      for (const res of [
        await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "Hacked" }) }),
        await restore(router, "welld_ch", 2, { baseVersion: 4 }),
        await save(router, "welld_de", { baseVersion: 4, details: details() }),
      ]) {
        expect(res.status).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).not.toContain("wellD SA");
      }
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("no grant at all: 403 forbidden (one constant body, whatever entity or version is named), nothing written", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const before = await snapshot(tx);
      signedInAs(await makeUser("no-grant", "welld_ch"));
      const router = writeRouter(tx);
      const bodies = new Set<string>();
      for (const res of [
        await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "Hacked" }) }),
        await save(router, "welld_it", { baseVersion: 4, details: details() }),
        await restore(router, "welld_ch", 2, { baseVersion: 4 }),
        await restore(router, "welld_ch", 999, { baseVersion: 4 }),
        await save(router, "welld_de", { baseVersion: 4, details: details() }), // learns nothing about which entities exist
        await save(router, "welld_ch", "not json at all"), // nor is the body looked at
      ]) {
        expect(res.status).toBe(403);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        const text = await res.text();
        expect(text).not.toContain("welld_de");
        bodies.add(text);
      }
      expect([...bodies]).toEqual([JSON.stringify(FORBIDDEN_BODY)]);
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("a welld_ch-conditioned grant: welld_ch saves (201), welld_it is 403 and nothing is written for it", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx, "welld_ch");
      await seedHistory(tx, "welld_it");
      signedInAs(await chManager("ch"));
      const router = writeRouter(tx);
      const before = await snapshot(tx);

      for (const res of [
        await save(router, "welld_it", { baseVersion: 4, details: details({ legalName: "Other entity" }) }),
        await restore(router, "welld_it", 2, { baseVersion: 4 }),
      ]) {
        expect(res.status).toBe(403);
        expect(await res.text()).toBe(JSON.stringify(FORBIDDEN_BODY));
      }
      expect(await snapshot(tx)).toEqual(before);

      const ok = await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "wellD Suisse SA" }) });
      expect(ok.status).toBe(201);
      expect(await countVersions(tx, "welld_ch")).toBe(5);
      expect(await countVersions(tx, "welld_it")).toBe(4);
    });
  });

  test("a conditioned grant on a person with no entity, and an unrecognised condition, cover nothing (fail closed)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const before = await snapshot(tx);
      const router = writeRouter(tx);

      const noEntity = await makeUser("cond-no-entity", null);
      await grantManage(noEntity.id, { attributes: [{ key: "entity", match: "user" }] });
      signedInAs(noEntity);
      for (const entity of ["welld_ch", "welld_it"]) {
        expect((await save(router, entity, { baseVersion: 4, details: details() })).status).toBe(403);
      }

      const odd = await makeUser("cond-odd", "welld_ch");
      await grantManage(odd.id, { ownership: "own" });
      await grantManage(odd.id, { attributes: [{ key: "jobTitle", match: "user" }] });
      signedInAs(odd);
      expect((await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "X" }) })).status).toBe(403);
      expect((await restore(router, "welld_ch", 2, { baseVersion: 4 })).status).toBe(403);
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("an unknown entity name is 404 unknown_legal_entity (fixed body) for a person who manages one", async () => {
    await inTx(async (tx) => {
      signedInAs(await admin("unknown-entity"));
      const router = writeRouter(tx);
      for (const res of [
        await save(router, "welld_de", { baseVersion: 1, details: details() }),
        await restore(router, "welld_de", 1, { baseVersion: 1 }),
        await save(router, "manageable", { baseVersion: 1, details: details() }),
      ]) {
        expect(res.status).toBe(404);
        expect(await res.text()).toBe(JSON.stringify(UNKNOWN_LEGAL_ENTITY_BODY));
      }
    });
  });

  test("there is no PUT, PATCH or DELETE on either path (404), and GET on a POST path is not served by this router", async () => {
    await inTx(async (tx) => {
      signedInAs(await admin("methods"));
      const router = writeRouter(tx);
      for (const method of ["PUT", "PATCH", "DELETE", "GET"]) {
        for (const path of ["/legal-entities/welld_ch/versions", "/legal-entities/welld_ch/versions/1/restore"]) {
          expect((await router.request(path, { method, headers: JSON_HEADERS, body: method === "GET" ? undefined : "{}" })).status).toBe(404);
        }
      }
    });
  });
});

// ─── Request shape ────────────────────────────────────────────────────────────────────────────────────────────────

describe("the request: 413 and 422 invalid_request", () => {
  const UNKNOWN_MEMBER = "zzSecretMemberName";

  test("a body over 16 KiB is 413 request_too_large, declared or streamed, and nothing is written", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const before = await snapshot(tx);
      signedInAs(await admin("too-large"));
      const router = writeRouter(tx);
      const huge = JSON.stringify({ baseVersion: 4, details: details({ legalName: "x".repeat(MAX_WRITE_BODY_BYTES) }) });
      expect(huge.length).toBeGreaterThan(MAX_WRITE_BODY_BYTES);

      const declared = await post(router, "/legal-entities/welld_ch/versions", huge);
      expect(declared.status).toBe(413);
      expect(await declared.text()).toBe(JSON.stringify(REQUEST_TOO_LARGE_BODY));
      expect(declared.headers.get("cache-control")).toBe("no-store");

      // No Content-Length: the stream is cut at the first byte past the cap.
      const chunks = new TextEncoder().encode(huge);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < chunks.length; i += 4096) controller.enqueue(chunks.slice(i, i + 4096));
          controller.close();
        },
      });
      const streamed = await router.request("/legal-entities/welld_ch/versions/2/restore", {
        method: "POST",
        headers: JSON_HEADERS,
        body: stream,
        duplex: "half",
      });
      expect(streamed.status).toBe(413);
      expect(await snapshot(tx)).toEqual(before);

      // Exactly at the cap is read (and then refused for what it says, not for its size).
      const pad = "y".repeat(MAX_WRITE_BODY_BYTES - JSON.stringify({ baseVersion: 4, details: details({ legalName: "" }) }).length);
      const atCap = JSON.stringify({ baseVersion: 4, details: details({ legalName: pad }) });
      expect(new TextEncoder().encode(atCap).length).toBe(MAX_WRITE_BODY_BYTES);
      expect((await post(router, "/legal-entities/welld_ch/versions", atCap)).status).toBe(422);
    });
  });

  test("a body that is not exactly the shape is 422 invalid_request: one constant body, no member name echoed", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const before = await snapshot(tx);
      signedInAs(await admin("shape"));
      const router = writeRouter(tx);
      const good = { baseVersion: 4, details: details({ legalName: "wellD Suisse SA" }) };
      const cases: [string, unknown][] = [
        ["unknown top-level member", { ...good, [UNKNOWN_MEMBER]: 1 }],
        ["unknown member in details", { ...good, details: { ...DETAILS, [UNKNOWN_MEMBER]: "x" } }],
        ["unknown member in address", { ...good, details: { ...DETAILS, address: { ...DETAILS.address, [UNKNOWN_MEMBER]: [] } } }],
        ["unknown member in contacts", { ...good, details: { ...DETAILS, contacts: { ...DETAILS.contacts, [UNKNOWN_MEMBER]: "" } } }],
        ["missing baseVersion", { details: DETAILS }],
        ["missing details", { baseVersion: 4 }],
        ["missing iban", { baseVersion: 4, details: { ...DETAILS, iban: undefined } }],
        ["missing contacts.en", { baseVersion: 4, details: { ...DETAILS, contacts: { it: "" } } }],
        ["baseVersion a string", { ...good, baseVersion: "4" }],
        ["baseVersion fractional", { ...good, baseVersion: 4.5 }],
        ["baseVersion negative", { ...good, baseVersion: -1 }],
        ["baseVersion over int4", { ...good, baseVersion: 2 ** 31 }],
        ["legalName a number", { ...good, details: { ...DETAILS, legalName: 7 } }],
        ["legalName null", { ...good, details: { ...DETAILS, legalName: null } }],
        ["address a string", { ...good, details: { ...DETAILS, address: "Via 1" } }],
        ["address.it holds a number", { ...good, details: { ...DETAILS, address: { it: [1], en: [] } } }],
        ["17 submitted address lines (E5 cap is 16)", { ...good, details: { ...DETAILS, address: { it: Array(17).fill("x"), en: ["x"] } } }],
        ["an array", [good]],
        ["null", null],
        ["a string", "just text"],
      ];
      for (const [label, body] of cases) {
        const res = await save(router, "welld_ch", body);
        expect([label, res.status]).toEqual([label, 422]);
        const text = await res.text();
        expect([label, text]).toEqual([label, JSON.stringify(INVALID_REQUEST_BODY)]);
        expect(text).not.toContain(UNKNOWN_MEMBER);
      }
      // Restore: the same, for its smaller shape.
      for (const body of [{}, { baseVersion: "4" }, { baseVersion: 4, details: DETAILS }, { baseVersion: 4, [UNKNOWN_MEMBER]: 1 }, { baseVersion: 1.5 }]) {
        const res = await restore(router, "welld_ch", 2, body);
        expect(res.status).toBe(422);
        const text = await res.text();
        expect(text).toBe(JSON.stringify(INVALID_REQUEST_BODY));
        expect(text).not.toContain(UNKNOWN_MEMBER);
      }
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("16 submitted address lines are accepted by the shape (too_many_lines is the rules' answer), 4 + blanks save", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("sixteen"));
      const router = writeRouter(tx);
      const sixteen = Array.from({ length: 16 }, (_, i) => `line ${i}`);
      const res = await save(router, "welld_ch", { baseVersion: 4, details: details({ address: { it: sixteen, en: ["x"] } }) });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_legal_entity");

      const withBlanks = ["a", "", "b", " ", "c", "", "d", "", "", "", "", "", "", "", "", ""];
      const ok = await save(router, "welld_ch", { baseVersion: 4, details: details({ address: { it: withBlanks, en: ["x"] } }) });
      expect(ok.status).toBe(201);
    });
  });

  test("anything that does not say it is JSON, and malformed JSON, is 422 invalid_request (a cross-site form cannot write)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const before = await snapshot(tx);
      signedInAs(await admin("not-json"));
      const router = writeRouter(tx);
      const body = JSON.stringify({ baseVersion: 4, details: details({ legalName: "wellD Suisse SA" }) });
      for (const headers of [{ "Content-Type": "text/plain" }, { "Content-Type": "application/x-www-form-urlencoded" }, {}]) {
        const res = await post(router, "/legal-entities/welld_ch/versions", body, headers);
        expect(res.status).toBe(422);
        expect(await res.text()).toBe(JSON.stringify(INVALID_REQUEST_BODY));
      }
      for (const text of ["{", "", "{\"baseVersion\":4,", "undefined"]) {
        const res = await post(router, "/legal-entities/welld_ch/versions", text);
        expect(res.status).toBe(422);
        expect(await res.text()).toBe(JSON.stringify(INVALID_REQUEST_BODY));
      }
      expect(await snapshot(tx)).toEqual(before);
    });
  });
});

// ─── Rules: 422 invalid_legal_entity ──────────────────────────────────────────────────────────────────────────────

describe("422 invalid_legal_entity (AC-1.2 to AC-1.4, E5)", () => {
  test("every problem at once, `line` = the submitted position, nothing written, no value echoed", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const before = await snapshot(tx);
      signedInAs(await admin("problems"));
      const router = writeRouter(tx);
      const res = await save(router, "welld_ch", {
        baseVersion: 4,
        details: {
          legalName: "   ",
          address: {
            it: ["", "x".repeat(121), "fine", "tab\there"],
            en: ["a", "b", "c", "d", "e"],
          },
          vatNumber: "CHE-SECRET\n1",
          iban: "CH9300762011623852958",
          contacts: { it: "c".repeat(201), en: "nul\u0000here" },
        },
      });
      expect(res.status).toBe(422);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      const body = JSON.parse(text);
      expect(body).toMatchObject({ status: 422, code: "invalid_legal_entity" });
      expect(body.problems).toEqual([
        { field: "legalName", reason: "required" },
        { field: "address.it", line: 1, reason: "too_long", limit: 120 },
        { field: "address.it", line: 3, reason: "control_character" },
        { field: "address.en", reason: "too_many_lines", limit: 4 },
        { field: "vatNumber", reason: "line_break" },
        { field: "iban", reason: "iban_check_digits" },
        { field: "contacts.it", reason: "too_long", limit: 200 },
        { field: "contacts.en", reason: "control_character" },
      ]);
      expect(text).not.toContain("CHE-SECRET");
      expect(text).not.toContain("CH9300762011623852958");
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("required: a blank-only address in each language and a missing VAT are refused with no line", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("required"));
      const router = writeRouter(tx);
      const res = await save(router, "welld_ch", {
        baseVersion: 4,
        details: details({ address: { it: ["", "  "], en: [] }, vatNumber: "" }),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { problems: unknown[] }).problems).toEqual([
        { field: "address.it", reason: "required" },
        { field: "address.en", reason: "required" },
        { field: "vatNumber", reason: "required" },
      ]);
    });
  });

  test("the boundaries of AC-1.3 in code points: 200/201, 120/121, 4/5 lines, 40/41, IBAN spaces, an emoji counts 1", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("limits"));
      const router = writeRouter(tx);
      const refused = async (over: Record<string, unknown>) => {
        const res = await save(router, "welld_ch", { baseVersion: 4, details: details(over) });
        return res.status === 422 ? ((await res.json()) as { problems: { field: string; line?: number; reason: string; limit?: number }[] }).problems : res.status;
      };
      expect(await refused({ legalName: "n".repeat(201) })).toEqual([{ field: "legalName", reason: "too_long", limit: 200, }]);
      expect(await refused({ vatNumber: "v".repeat(41) })).toEqual([{ field: "vatNumber", reason: "too_long", limit: 40 }]);
      expect(await refused({ address: { it: ["a", "b", "c", "d", "e"], en: ["x"] } })).toEqual([
        { field: "address.it", reason: "too_many_lines", limit: 4 },
      ]);
      expect(await refused({ address: { it: ["é".repeat(121)], en: ["x"] } })).toEqual([
        { field: "address.it", line: 0, reason: "too_long", limit: 120 },
      ]);
      // 200 emoji are 200 code points (400 UTF-16 units): accepted. The stored value is the one sent.
      const ok = await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "😀".repeat(200) }) });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { entity: { legalName: string } }).entity.legalName).toBe("😀".repeat(200));
      expect((await save(router, "welld_ch", { baseVersion: 5, details: details({ legalName: "😀".repeat(201) }) })).status).toBe(422);
    });
  });
});

// ─── Save ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("save: 201, no-op, conflict, not moved (AC-1.5, AC-2.1, AC-2.5, AC-2.6)", () => {
  test("a one-value change creates version n+1 with the person and the time, and one audit row of only that change", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const person = await admin("one-change");
      signedInAs(person);
      const auditBefore = await countAudit(tx, "welld_ch");
      const t0 = Date.now();
      const res = await save(writeRouter(tx), "welld_ch", {
        baseVersion: 4,
        details: details({ legalName: "wellD SA (v4)", contacts: { it: "Tel. +41 91 000 00 00", en: "" }, iban: "CH56 0483 5012 3456 7800 9" }),
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { version: number; created: boolean; entity: Record<string, unknown> };
      expect(body.version).toBe(5);
      expect(body.created).toBe(true);
      // The full LegalEntity of the new version, as the read routes serialise it (T34's client parses exactly this).
      expect(body.entity).toMatchObject({
        entity: "welld_ch",
        version: 5,
        legalName: "wellD SA (v4)",
        iban: "CH5604835012345678009",
        ibanPrint: "CH56 0483 5012 3456 7800 9",
        complete: true,
        missing: [],
        invalid: [],
      });
      expect(Object.keys(body.entity)).toEqual([
        "entity", "version", "updatedAt", "legalName", "address", "vatNumber", "iban", "ibanPrint", "contacts", "complete", "missing", "invalid",
      ]);
      const updatedAt = Date.parse(body.entity["updatedAt"] as string);
      expect(updatedAt).toBeGreaterThan(t0 - 5000);
      expect(updatedAt).toBeLessThan(Date.now() + 5000);

      const row = await tx.legalEntityVersion.findUniqueOrThrow({ where: { entity_version: { entity: "welld_ch", version: 5 } } });
      expect(row).toMatchObject({
        action: "save",
        restoredFrom: null,
        changedFields: ["iban"],
        createdByUserId: person.id,
        createdByName: person.name,
      });
      expect(row.createdAt.toISOString()).toBe(body.entity["updatedAt"] as string);

      // Versions 1 to 4 untouched.
      expect(await countVersions(tx, "welld_ch")).toBe(5);

      // One audit row, before/after of the changed value and only that one (AC-2.5).
      expect(await countAudit(tx, "welld_ch")).toBe(auditBefore + 1);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { targetType: "legal_entity", targetId: "welld_ch", actorUserId: person.id } });
      expect(audit.action).toBe("legal_entity.save");
      expect(audit.data).toEqual({
        version: 5,
        baseVersion: 4,
        changes: { iban: { before: "CH9300762011623852957", after: "CH5604835012345678009" } },
      });
      expect(audit.summary).not.toContain("CH56"); // the summary names fields, never values

      // The history shows it, with the person.
      signedInAs(person);
      const history = await createLegalEntityHistoryRouter(tx).request("/legal-entities/welld_ch/versions");
      const items = ((await history.json()) as { items: { version: number; createdBy: { id: string; name: string }; changedFields: string[] }[] }).items;
      expect(items[0]).toMatchObject({ version: 5, createdBy: { id: person.id, name: person.name }, changedFields: ["iban"] });
    });
  });

  test("what is stored is the normalised form, never the raw body (AC-1.4, AC-2.1)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("normalised"));
      const nfd = "Café SA"; // NFD
      const res = await save(writeRouter(tx), "welld_ch", {
        baseVersion: 4,
        details: {
          legalName: `  ${nfd}  `,
          address: { it: ["", "  Via Cantonale 1  ", " ", "6900 Lugano"], en: ["Via Cantonale 1", "", "6900 Lugano"] },
          vatNumber: "  CHE-123.456.789 IVA ",
          iban: " ch93 0076 2011 6238 5295 7 ",
          contacts: { it: " Tel. 1 ", en: "" },
        },
      });
      expect(res.status).toBe(201);
      const row = await tx.legalEntityVersion.findUniqueOrThrow({ where: { entity_version: { entity: "welld_ch", version: 5 } } });
      expect(row).toMatchObject({
        legalName: "Café SA",
        addressIt: ["Via Cantonale 1", "6900 Lugano"],
        addressEn: ["Via Cantonale 1", "6900 Lugano"],
        vatNumber: "CHE-123.456.789 IVA",
        iban: "CH9300762011623852957",
        contactsIt: "Tel. 1",
        contactsEn: "",
      });
      expect(row.legalName.normalize("NFC")).toBe(row.legalName);
    });
  });

  test("an equivalent body (IBAN spaces and case, trailing blanks, a blank address line, NFD) is 200 created:false: no row, no audit row", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("no-op"));
      const router = writeRouter(tx);
      // v4 holds legalName "wellD SA (v4)", contacts.it "Tel. +41 91 000 00 00".
      const current = {
        legalName: "wellD SA (v4)",
        address: { it: ["Via Cantonale 1", "6900 Lugano"], en: ["Via Cantonale 1", "6900 Lugano, Switzerland"] },
        vatNumber: "CHE-123.456.789 IVA",
        iban: "CH9300762011623852957",
        contacts: { it: "Tel. +41 91 000 00 00", en: "" },
      };
      const variants = [
        current,
        { ...current, iban: "ch93 0076 2011 6238 5295 7" },
        { ...current, legalName: "  wellD SA (v4)   ", vatNumber: "\tCHE-123.456.789 IVA\t".replace("\t", " ") },
        { ...current, address: { it: ["Via Cantonale 1", "", "6900 Lugano", "  "], en: ["", "Via Cantonale 1", "6900 Lugano, Switzerland"] } },
        { ...current, legalName: "wellD SA (v4)".normalize("NFD") },
      ];
      const before = await snapshot(tx);
      for (const d of variants) {
        const res = await save(router, "welld_ch", { baseVersion: 4, details: d });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { version: number; created: boolean; entity: { version: number; legalName: string } };
        expect(body).toMatchObject({ version: 4, created: false, entity: { version: 4, legalName: "wellD SA (v4)" } });
      }
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("a no-op still answers 409 when the base is stale: the conflict is judged first", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("noop-stale"));
      const res = await save(writeRouter(tx), "welld_ch", {
        baseVersion: 3,
        details: { ...DETAILS, legalName: "wellD SA (v4)", contacts: { it: "Tel. +41 91 000 00 00", en: "" } },
      });
      expect(res.status).toBe(409);
    });
  });

  test("a stale base is 409 version_conflict + currentVersion; the table and the audit log are unchanged", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("conflict"));
      const router = writeRouter(tx);
      const before = await snapshot(tx);
      const mine = { legalName: "Mine SA" };

      // Two saves on base 4: one wins, the other conflicts and reports the version that is now current.
      const first = await save(router, "welld_ch", { baseVersion: 4, details: details(mine) });
      expect(first.status).toBe(201);
      const second = await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "Yours SA" }) });
      expect(second.status).toBe(409);
      expect(second.headers.get("cache-control")).toBe("no-store");
      const body = await second.json();
      expect(body).toMatchObject({ status: 409, code: "version_conflict", currentVersion: 5 });
      expect(await countVersions(tx, "welld_ch")).toBe(5);
      expect(await countAudit(tx, "welld_ch")).toBe(before.audit + 1);
      expect((await tx.legalEntityVersion.findUniqueOrThrow({ where: { entity_version: { entity: "welld_ch", version: 5 } } })).legalName).toBe("Mine SA");

      // A base from the future, and 0, conflict as well; the answer always names the current version.
      for (const base of [6, 0, 2 ** 31 - 1]) {
        const res = await save(router, "welld_ch", { baseVersion: base, details: details({ legalName: "Z SA" }) });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "version_conflict", currentVersion: 5 });
      }
      expect(await countVersions(tx, "welld_ch")).toBe(5);
      // The other entity has its own version counter.
      expect(await countVersions(tx, "welld_it")).toBe(0);
    });
  });

  test("an entity with no version is 409 legal_entity_not_moved (fixed body), whatever the base, and nothing is written", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx, "welld_ch");
      signedInAs(await admin("not-moved"));
      const router = writeRouter(tx);
      const before = await snapshot(tx);
      for (const base of [0, 1]) {
        const res = await save(router, "welld_it", { baseVersion: base, details: details() });
        expect(res.status).toBe(409);
        expect(await res.text()).toBe(JSON.stringify(NOT_MOVED_BODY));
      }
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("a restore of a version that does not exist is 404 version_not_found, also on an entity not moved", async () => {
    await inTx(async (tx) => {
      signedInAs(await admin("restore-notmoved"));
      const res = await restore(writeRouter(tx), "welld_it", 1, { baseVersion: 1 });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(JSON.stringify(VERSION_NOT_FOUND_BODY));
    });
  });
});

// ─── Restore ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("restore (AC-2.4, D4, E1)", () => {
  test("restore 2 when 4 is current: version 5 equals 2, restoredFrom 2, versions 1 to 4 unchanged, one audit row", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const person = await admin("restore");
      signedInAs(person);
      const router = writeRouter(tx);
      const rowsBefore = await tx.legalEntityVersion.findMany({ orderBy: { version: "asc" } });
      const auditBefore = await countAudit(tx, "welld_ch");

      const res = await restore(router, "welld_ch", 2, { baseVersion: 4 });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { version: number; created: boolean; entity: Record<string, unknown> };
      expect(body).toMatchObject({ version: 5, created: true, entity: { version: 5, legalName: "wellD SA", contacts: { it: "", en: "" } } });

      const rows = await tx.legalEntityVersion.findMany({ orderBy: { version: "asc" } });
      expect(rows).toHaveLength(5);
      expect(rows.slice(0, 4)).toEqual(rowsBefore); // 1 to 4 unchanged
      const v2 = rows[1]!;
      const v5 = rows[4]!;
      expect(v5).toMatchObject({
        action: "restore",
        restoredFrom: 2,
        createdByUserId: person.id,
        createdByName: person.name,
        legalName: v2.legalName,
        addressIt: v2.addressIt,
        addressEn: v2.addressEn,
        vatNumber: v2.vatNumber,
        iban: v2.iban,
        contactsIt: v2.contactsIt,
        contactsEn: v2.contactsEn,
        changedFields: ["legalName", "contacts.it"], // against the version it replaced (v4)
      });

      expect(await countAudit(tx, "welld_ch")).toBe(auditBefore + 1);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { targetType: "legal_entity", targetId: "welld_ch", action: "legal_entity.restore" } });
      expect(audit.actorUserId).toBe(person.id);
      expect(audit.data).toEqual({
        version: 5,
        baseVersion: 4,
        restoredFrom: 2,
        changes: {
          legalName: { before: "wellD SA (v4)", after: "wellD SA" },
          "contacts.it": { before: "Tel. +41 91 000 00 00", after: "" },
        },
      });
    });
  });

  test("restoring the current version is 200 created:false (no row, no audit row); a stale base is 409 first", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("restore-current"));
      const router = writeRouter(tx);
      const before = await snapshot(tx);
      const same = await restore(router, "welld_ch", 4, { baseVersion: 4 });
      expect(same.status).toBe(200);
      expect(await same.json()).toMatchObject({ version: 4, created: false, entity: { version: 4 } });
      // A version that EQUALS the current one (v3 -> v5 would not; seed one that does) is a no-op as well.
      expect(await snapshot(tx)).toEqual(before);

      const stale = await restore(router, "welld_ch", 2, { baseVersion: 3 });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "version_conflict", currentVersion: 4 });
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("the restore guard is the history's `restorable` flag: a non-restorable version is 422 invalid_legal_entity, nothing written (D4)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      // v5: an invalid moved value as it can exist after the import (bad IBAN check digits, a line break in the VAT).
      await seed(tx, { entity: "welld_ch", version: 5, ...GOOD, iban: "CH9300762011623852958", vatNumber: "CHE 1", changedFields: ["iban", "vatNumber"] });
      await seed(tx, { entity: "welld_ch", version: 6, ...GOOD, legalName: "wellD SA (v6)", changedFields: ["legalName", "iban", "vatNumber"] });
      signedInAs(await admin("guard"));
      const router = writeRouter(tx);
      const before = await snapshot(tx);

      const history = await createLegalEntityHistoryRouter(tx).request("/legal-entities/welld_ch/versions");
      const flags = new Map(((await history.json()) as { items: { version: number; restorable: boolean }[] }).items.map((i) => [i.version, i.restorable]));
      expect([...flags.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, false], [2, true], [3, true], [4, true], [5, false], [6, true]]);

      for (const n of [1, 5]) {
        const res = await restore(router, "welld_ch", n, { baseVersion: 6 });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { code: string; problems: { field: string; reason: string }[] };
        expect(body.code).toBe("invalid_legal_entity");
        expect(body.problems.length).toBeGreaterThan(0);
        if (n === 5) {
          expect(body.problems).toEqual([
            { field: "vatNumber", reason: "line_break" },
            { field: "iban", reason: "iban_check_digits" },
          ]);
        } else {
          expect(body.problems.map((p) => p.reason)).toContain("required"); // v1: no VAT, no English address
        }
      }
      expect(await snapshot(tx)).toEqual(before);

      // And every version the history calls restorable restores (the flag and the guard cannot drift).
      for (const n of [2, 3, 4]) {
        expect(flags.get(n)).toBe(true);
        const res = await restore(router, "welld_ch", n, { baseVersion: (await countVersions(tx, "welld_ch")) });
        expect([201, 200]).toContain(res.status);
      }
    });
  });

  test("version_not_found: 404 constant body for an absent, non-canonical or out-of-range n; the number is not echoed", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("restore-404"));
      const router = writeRouter(tx);
      const before = await snapshot(tx);
      for (const n of ["5", "99", "0", "-1", "1.5", "01", "abc", "1e2", "99999999999999999999", "%20"]) {
        const res = await restore(router, "welld_ch", n, { baseVersion: 4 });
        expect([n, res.status]).toEqual([n, 404]);
        expect(await res.text()).toBe(JSON.stringify(VERSION_NOT_FOUND_BODY));
      }
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("a restore never moves another entity's version: n of welld_it is not a version of welld_ch", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx, "welld_ch");
      await seed(tx, { entity: "welld_it", version: 1, ...GOOD, legalName: "wellD Srl", changedFields: [] });
      signedInAs(await admin("restore-cross"));
      const res = await restore(writeRouter(tx), "welld_it", 2, { baseVersion: 1 });
      expect(res.status).toBe(404);
      expect(await countVersions(tx, "welld_it")).toBe(1);
    });
  });
});

// ─── The hand-over to the notice dispatcher (T59; AC-9.7, AC-9.14, AC-9.17) ───────────────────────────────────────

describe("the kick after commit (T59)", () => {
  const withKick = (tx: Tx, kick: () => unknown) =>
    createLegalEntityWriteRouter({ audited: auditedIn(tx), client: tx, notices: { kick } });

  test("a protected save and a protected restore kick once, after the version is stored; the answer is the same", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("kick-protected"));
      let kicks = 0;
      const seen: Promise<number>[] = [];
      const kick = () => {
        kicks += 1;
        // The kick runs after the transaction body: the new version is already there to be read.
        seen.push(tx.legalEntityVersion.count({ where: { entity: "welld_ch", version: 4 + kicks } }));
      };
      const router = withKick(tx, kick);

      const res = await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "wellD SA (v4)", iban: "CH56 0483 5012 3456 7800 9" }) });
      expect(res.status).toBe(201);
      expect(kicks).toBe(1);
      expect(await seen[0]).toBe(1);

      // Restoring version 2 changes the IBAN and the legal name back: a protected change again.
      const back = await restore(router, "welld_ch", 2, { baseVersion: 5 });
      expect(back.status).toBe(201);
      expect(kicks).toBe(2);
      expect(await seen[1]).toBe(1);
    });
  });

  test("no kick for what is not a protected change, a no-op or a refusal (AC-9.17)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("kick-none"));
      let kicks = 0;
      const router = withKick(tx, () => void (kicks += 1));

      expect((await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "wellD SA (v4)", contacts: { it: "Tel. +41 91 000 00 00", en: "x" } }) })).status).toBe(201);
      expect((await save(router, "welld_ch", { baseVersion: 5, details: details({ legalName: "wellD SA (v4)", contacts: { it: "Tel. +41 91 000 00 00", en: "x" }, iban: "ch93 0076 2011 6238 5295 7" }) })).status).toBe(200); // spacing and case only
      expect((await save(router, "welld_ch", { baseVersion: 1, details: details({ legalName: "Stale SA" }) })).status).toBe(409);
      expect((await save(router, "welld_ch", { baseVersion: 5, details: details({ legalName: "" }) })).status).toBe(422);
      expect((await save(router, "welld_it", { baseVersion: 0, details: details({ legalName: "Not Moved SA" }) })).status).toBe(409);
      expect(kicks).toBe(0);
    });
  });

  test("a kick that throws or rejects never changes the answer", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("kick-broken"));
      const thrown = await save(withKick(tx, () => { throw new Error("kick exploded"); }), "welld_ch", { baseVersion: 4, details: details({ legalName: "Kick A SA" }) });
      expect(thrown.status).toBe(201);
      const rejected = await save(withKick(tx, () => Promise.reject(new Error("kick rejected"))), "welld_ch", { baseVersion: 5, details: details({ legalName: "Kick B SA" }) });
      expect(rejected.status).toBe(201);
      expect(((await rejected.json()) as { version: number }).version).toBe(6);
    });
  });

  test("the default kick does nothing until the server started the dispatcher (a test of the routes sends nothing)", async () => {
    const { kickNotices, noticeDispatcherStarted } = await import("./notices/dispatcher");
    expect(noticeDispatcherStarted()).toBe(false);
    await expect(kickNotices()).resolves.toBeUndefined();
  });
});

// ─── Failure handling ─────────────────────────────────────────────────────────────────────────────────────────────

describe("an unexpected failure", () => {
  test("is a constant 500, nothing of the request or of the error is answered or logged beyond its class", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("boom"));
      const failing: Audited = (async () => {
        throw Object.assign(new Error('Failing row contains (CH9300762011623852957, SECRET-IBAN-TEXT)'), { code: "23514" });
      }) as Audited;
      const logged: string[] = [];
      const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
      try {
        const res = await save(writeRouter(tx, failing), "welld_ch", { baseVersion: 4, details: details({ legalName: "Secret Legal Name" }) });
        expect(res.status).toBe(500);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        expect(JSON.parse(text)).toMatchObject({ status: 500, code: "internal_error" });
        for (const secret of ["Secret Legal Name", "SECRET-IBAN-TEXT", "CH9300762011623852957"]) {
          expect(text).not.toContain(secret);
          expect(logged.join("\n")).not.toContain(secret);
        }
        expect(logged.join("\n")).toContain("23514");
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("a deleted person (F2)", () => {
  test("a soft-deleted holder with a live session is 403 forbidden on save and restore, nothing written", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const before = await snapshot(tx);
      const person = await admin("deleted-holder");
      signedInAs(person); // the session outlives the delete: the mocked source still answers it
      await db.user.update({ where: { id: person.id }, data: { deletedAt: new Date() } });
      const router = writeRouter(tx);
      const bodies = new Set<string>();
      for (const res of [
        await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "Still Here SA" }) }),
        await save(router, "welld_it", { baseVersion: 4, details: details() }),
        await restore(router, "welld_ch", 2, { baseVersion: 4 }),
        await save(router, "welld_de", { baseVersion: 4, details: details() }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.headers.get("cache-control")).toBe("no-store");
        bodies.add(await res.text());
      }
      expect(Array.from(bodies)).toEqual([JSON.stringify(FORBIDDEN_BODY)]);
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("a session whose user row is gone is refused the same way", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs({ id: `no-such-user-${RUN_ID}`, email: "ghost@legalentities.test", name: "Ghost" });
      const res = await save(writeRouter(tx), "welld_ch", { baseVersion: 4, details: details({ legalName: "Ghost SA" }) });
      expect(res.status).toBe(403);
    });
  });
});

describe("the throttle (F3, plan G9)", () => {
  const nameOf = (i: number) => `Throttled SA ${i}`;

  test("the 11th save-or-restore of one person within the window is 429 too_many_requests with Retry-After, nothing written", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const person = await admin("throttled");
      const other = await admin("throttled-other");
      signedInAs(person);
      // The env's limits (10 per person): the router is built without a `limits` of its own.
      const router = createThrottledWriteRouter({ audited: auditedIn(tx), client: tx });

      // Save and restore share one window: five of each are ten.
      for (let i = 0; i < 5; i++) {
        const res = await save(router, "welld_ch", { baseVersion: 4 + i * 2, details: details({ legalName: nameOf(i) }) });
        expect(res.status).toBe(201);
        const back = await restore(router, "welld_ch", 2, { baseVersion: 5 + i * 2 });
        expect(back.status).toBe(201);
      }
      const before = await snapshot(tx);
      expect(before.versions.filter((v) => v.entity === "welld_ch")).toHaveLength(14);

      // Counted before the body is read: not even valid JSON is needed to be refused.
      for (const res of [
        await save(router, "welld_ch", { baseVersion: 14, details: details({ legalName: "Eleventh SA" }) }),
        await restore(router, "welld_ch", 2, { baseVersion: 14 }),
        await save(router, "welld_ch", "not json at all"),
      ]) {
        expect(res.status).toBe(429);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const retryAfter = Number(res.headers.get("retry-after"));
        expect(Number.isInteger(retryAfter)).toBe(true);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(600);
        expect(await res.text()).toBe(JSON.stringify(TOO_MANY_REQUESTS_BODY));
      }
      expect(await snapshot(tx)).toEqual(before);

      // Another person is unaffected.
      signedInAs(other);
      const fine = await save(router, "welld_ch", { baseVersion: 14, details: details({ legalName: "Other Person SA" }) });
      expect(fine.status).toBe(201);
    });
  });

  test("a refusal that comes before it never spends the allowance: 401, 403, 404 are not counted", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const router = createLegalEntityWriteRouter({ audited: auditedIn(tx), client: tx, limits: createLegalEntityRateLimits({ writeLimit: 2 }) });
      const noGrant = await makeUser("throttle-no-grant", "welld_ch");
      signedInAs(noGrant);
      for (let i = 0; i < 5; i++) expect((await save(router, "welld_ch", { baseVersion: 4, details: details() })).status).toBe(403);
      const manager = await chManager("throttle-ch");
      signedInAs(manager);
      for (let i = 0; i < 5; i++) expect((await save(router, "welld_it", { baseVersion: 4, details: details() })).status).toBe(403);
      for (let i = 0; i < 5; i++) expect((await save(router, "welld_de", { baseVersion: 4, details: details() })).status).toBe(404);
      // Still two to spend.
      expect((await save(router, "welld_ch", { baseVersion: 4, details: details({ legalName: "Spent 1 SA" }) })).status).toBe(201);
      expect((await save(router, "welld_ch", { baseVersion: 5, details: details({ legalName: "Spent 2 SA" }) })).status).toBe(201);
      expect((await save(router, "welld_ch", { baseVersion: 6, details: details({ legalName: "Spent 3 SA" }) })).status).toBe(429);
    });
  });

  test("the limits come from the env (10 and 60 per 10 minutes) and the window slides", () => {
    const limits = createLegalEntityRateLimits();
    for (let i = 0; i < 10; i++) expect(limits.write.consume("p", 1_000).allowed).toBe(true);
    expect(limits.write.consume("p", 1_000).allowed).toBe(false);
    expect(limits.write.consume("q", 1_000).allowed).toBe(true);
    for (let i = 0; i < 60; i++) expect(limits.check.consume("p", 1_000).allowed).toBe(true);
    expect(limits.check.consume("p", 1_000).allowed).toBe(false);
    // The window is 600000 ms: the same person is admitted again once the first attempts age out.
    expect(limits.write.consume("p", 1_000 + 600_000).allowed).toBe(true);
  });
});

describe("the documentation", () => {
  test("the OpenAPI document describes both POST routes with their bodies and refusals", async () => {
    const doc = createLegalEntityWriteRouter().getOpenAPIDocument({ openapi: "3.0.0", info: { title: "t", version: "1" } });
    const paths = doc.paths as Record<string, Record<string, { requestBody?: unknown; responses: Record<string, unknown> }>>;
    for (const path of ["/legal-entities/{entity}/versions", "/legal-entities/{entity}/versions/{n}/restore"]) {
      const op = paths[path]?.["post"];
      expect(op?.requestBody).toBeDefined();
      for (const status of ["200", "201", "401", "403", "404", "409", "413", "422", "429"]) expect(op?.responses[status]).toBeDefined();
    }
    expect(Object.keys(paths).every((p) => Object.keys(paths[p]!).every((m) => m === "post"))).toBe(true);
  });
});

// ─── Real transactions: the lock, a rollback after the insert, 20 parallel saves ──────────────────────────────────

describe("the committed-transaction guard (F4)", () => {
  test.each([
    "postgresql://u:p@localhost:5435/db",
    "postgresql://u:p@127.0.0.1:5432/db",
    "postgresql://u:p@[::1]:5432/db",
    "postgres://u:p@host.docker.internal:5432/db",
    "postgresql://u:p@postgres:5432/db",
    "postgresql://u:p@LOCALHOST/db?schema=public",
  ])("%s runs", (url) => {
    expect(isLocalDatabaseHost(url)).toBe(true);
    expect(committedTransactionsSkipReason(url)).toBeNull();
  });

  test.each([
    "postgresql://u:p@x.railway.internal:5432/db",
    "postgresql://u:p@x.proxy.rlwy.net:5432/db",
    "postgresql://u:p@db.example.com:5432/db",
    "postgresql://u:p@localhost.evil.com:5432/db",
    "postgresql://u:p@10.0.0.5:5432/db",
    "postgresql://u:p@localhost/db?host=x.railway.internal",
    "postgresql://u:p@localhost:5432,x.railway.internal:5432/db",
    "mysql://u:p@localhost/db",
    "not a url",
    "",
    undefined,
  ])("%p is skipped", (url) => {
    expect(isLocalDatabaseHost(url)).toBe(false);
    expect(committedTransactionsSkipReason(url)).not.toBeNull();
  });

  test("the skip line names the reason and not the URL", () => {
    const url = "postgresql://secretuser:secretpass@x.railway.internal:5432/proddb";
    const line = committedTransactionsSkipReason(url)!;
    expect(line).not.toContain("\n");
    expect(line).toContain("local database host");
    for (const leak of ["secretuser", "secretpass", "railway", "proddb"]) expect(line).not.toContain(leak);
  });
});

const hostSkip = committedTransactionsSkipReason(process.env.DATABASE_URL);
if (hostSkip) console.warn(hostSkip);
const registryIsEmpty = hostSkip === null && (await committedVersionCount()) === 0;
if (hostSkip === null && !registryIsEmpty) {
  console.warn(
    "write.routes.test.ts: the 'real transactions' group is SKIPPED because legal_entity_version already holds rows " +
      "(it needs a database with no registry, and removes its own rows afterwards). Use a fresh test database to run it.",
  );
}
const realSuite = registryIsEmpty ? describe : describe.skip;

realSuite("real transactions (committed; the registry is emptied again afterwards)", () => {
  const ENTITY: LegalEntity = "welld_ch";
  const post0 = (router: Requestable, body: unknown) => save(router, ENTITY, body);

  async function wipeRegistry() {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      // The notice rows first: the saves of this group that changed a protected detail wrote them (T58), and a version
      // deleted from under a notice would leave it behind as an orphan.
      await tx.$executeRawUnsafe("DELETE FROM legal_entity_notice");
      await tx.$executeRawUnsafe("DELETE FROM legal_entity_version");
    });
    await db.auditLog.deleteMany({ where: { actorUserId: { in: Array.from(createdUserIds) } } });
  }

  beforeAll(async () => {
    // Version 1: the system's import, as T9 writes it (details empty: the saves below complete it).
    await db.$executeRawUnsafe(insertSql(validImportRow(ENTITY)));
  });
  afterAll(wipeRegistry);

  const currentVersion = async () => (await db.legalEntityVersion.findMany({ where: { entity: ENTITY }, orderBy: { version: "desc" }, take: 1 }))[0]!.version;

  test("a failure after the insert leaves neither the version row nor the audit row", async () => {
    const person = await admin("real-rollback");
    signedInAs(person);
    const base = await currentVersion();
    const auditBefore = await db.auditLog.count({ where: { targetType: "legal_entity", targetId: ENTITY } });
    let insertedInsideTransaction = false;

    const failAfterInsert: Audited = ((params) =>
      withAudit({
        ...params,
        mutate: async (tx) => {
          const result = await params.mutate(tx);
          insertedInsideTransaction = (await tx.legalEntityVersion.count({ where: { entity: ENTITY, version: base + 1 } })) === 1;
          return result;
        },
        entry: () => {
          throw new Error("forced failure after the insert");
        },
      })) as Audited;
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await post0(createLegalEntityWriteRouter({ audited: failAfterInsert }), { baseVersion: base, details: details({ legalName: "Rolled Back SA" }) });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(insertedInsideTransaction).toBe(true); // the row existed inside the transaction: the rollback is what removed it
    expect(await currentVersion()).toBe(base);
    expect(await db.legalEntityVersion.count({ where: { legalName: "Rolled Back SA" } })).toBe(0);
    expect(await db.auditLog.count({ where: { targetType: "legal_entity", targetId: ENTITY } })).toBe(auditBefore);

    // And the real path, once: it commits the version and its audit row together.
    const ok = await post0(createLegalEntityWriteRouter(), { baseVersion: base, details: details({ legalName: "Committed SA" }) });
    expect(ok.status).toBe(201);
    expect(await currentVersion()).toBe(base + 1);
    expect(await db.auditLog.count({ where: { targetType: "legal_entity", targetId: ENTITY, actorUserId: person.id } })).toBe(1);
  });

  test("a save waits for the entity's advisory lock (the key the import script takes too) and then goes on", async () => {
    // One name for the lock in both places.
    expect(lockKey(ENTITY)).toBe("legal_entity:welld_ch");
    const importSource = readFileSync(join(import.meta.dir, "import.ts"), "utf8");
    expect(importSource).toContain("`legal_entity:${entity}`");
    expect(importSource).toContain("pg_advisory_xact_lock(hashtext(");

    signedInAs(await admin("real-lock"));
    const base = await currentVersion();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await lockEntity(tx, ENTITY);
        held();
        await released;
      },
      { timeout: 30_000 },
    );
    await holding;

    let settled = false;
    const pending = Promise.resolve(post0(createLegalEntityWriteRouter(), { baseVersion: base, details: details({ legalName: "After The Lock SA" }) })).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false); // blocked on the lock
    expect(await currentVersion()).toBe(base);

    release();
    await holder;
    const res = await pending;
    expect(res.status).toBe(201);
    expect(await currentVersion()).toBe(base + 1);
  });

  test("20 parallel saves on the same base: one 201, nineteen 409 naming the new version, contiguous versions", async () => {
    signedInAs(await admin("real-race"));
    const router = createLegalEntityWriteRouter();
    const base = await currentVersion();
    const versionsBefore = await db.legalEntityVersion.count({ where: { entity: ENTITY } });

    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post0(router, { baseVersion: base, details: details({ legalName: `Race ${i} SA` }) })),
    );
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    for (const res of answers.filter((r) => r.status === 409)) {
      expect(await res.json()).toMatchObject({ code: "version_conflict", currentVersion: base + 1 });
    }
    expect(await db.legalEntityVersion.count({ where: { entity: ENTITY } })).toBe(versionsBefore + 1);
    expect(await currentVersion()).toBe(base + 1);
  });

  test("20 clients that each retry from currentVersion all succeed: contiguous versions, one audit row each", async () => {
    const person = await admin("real-retry");
    signedInAs(person);
    const router = createLegalEntityWriteRouter();
    const base = await currentVersion();
    const auditBefore = await db.auditLog.count({ where: { targetType: "legal_entity", targetId: ENTITY, actorUserId: person.id } });

    const client = async (i: number): Promise<number> => {
      let from = base;
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await post0(router, { baseVersion: from, details: details({ legalName: `Retry ${i} SA` }) });
        if (res.status === 201) return ((await res.json()) as { version: number }).version;
        expect(res.status).toBe(409); // never a 500, never a duplicate-key error
        from = ((await res.json()) as { currentVersion: number }).currentVersion;
      }
      throw new Error(`client ${i} never got in`);
    };
    const versions = await Promise.all(Array.from({ length: 20 }, (_, i) => client(i)));

    expect([...versions].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => base + 1 + i));
    const rows = await db.legalEntityVersion.findMany({ where: { entity: ENTITY }, orderBy: { version: "asc" }, select: { version: true } });
    expect(rows.map((r) => r.version)).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1)); // no gap, no duplicate
    expect(await db.auditLog.count({ where: { targetType: "legal_entity", targetId: ENTITY, actorUserId: person.id } })).toBe(auditBefore + 20);
  });
});
