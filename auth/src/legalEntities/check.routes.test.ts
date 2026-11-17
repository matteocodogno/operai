/**
 * `POST /legal-entities/{entity}/versions/check` (specs/20261117-legal-entities, T55; AC-9.1, AC-9.5, AC-9.17; plan
 * G1.7, G5, G9, G12). Every test that touches `legal_entity_version` runs in a rolled-back transaction (`testDb.ts`);
 * the router reads through that transaction.
 */

import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import type { LegalEntity } from "./entities";
import { inRolledBackTx, type Tx } from "./testDb";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;

mock.module("../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession) } },
}));

const {
  createLegalEntityRateLimits,
  createLegalEntityWriteRouter,
  legalEntityRateLimits,
  MAX_WRITE_BODY_BYTES,
  TOO_MANY_REQUESTS_BODY,
  INVALID_REQUEST_BODY,
  NOT_MOVED_BODY,
  REQUEST_TOO_LARGE_BODY,
  INTERNAL_BODY,
} = await import("./write.routes");
const { createLegalEntityCheckRouter, checkAnswer } = await import("./check.routes");
const { FORBIDDEN_BODY } = await import("./history.routes");
const { UNKNOWN_LEGAL_ENTITY_BODY } = await import("./read.routes");
const { lockEntity } = await import("./repo");

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();

async function makeUser(label: string, entity: string | null = null) {
  const user = await db.user.create({
    data: { name: `T55 fixture ${label}`, email: `t55-le-check-${label}-${RUN_ID}-${crypto.randomUUID()}@legalentities.test`, entity },
  });
  createdUserIds.add(user.id);
  return user;
}

async function grantManage(userId: string, conditions: Record<string, unknown> | null) {
  const role = await db.role.create({ data: { name: `t55-le-check-${RUN_ID}-${crypto.randomUUID()}` } });
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

// ─── Harness ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A registry with no version, whatever was committed before: removed inside the rolled-back transaction only. */
async function emptyRegistry(tx: Tx): Promise<void> {
  if ((await tx.legalEntityVersion.count()) === 0) return;
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
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
  legalName?: string;
  addressIt?: string[];
  addressEn?: string[];
  vatNumber?: string;
  iban?: string;
  contactsIt?: string;
  contactsEn?: string;
}

async function seed(tx: Tx, s: Seed) {
  const action = s.version === 1 ? "import" : "save";
  const by = action === "import" ? null : { id: "u-seeded", name: "Sara Seeded" };
  await tx.$executeRaw`
    INSERT INTO legal_entity_version
      ("entity","version","legalName","addressIt","addressEn","vatNumber","iban","contactsIt","contactsEn",
       "action","restoredFrom","changedFields","createdByUserId","createdByName","createdAt")
    VALUES (${s.entity}, ${s.version}, ${s.legalName ?? ""}, ${s.addressIt ?? []}::text[], ${s.addressEn ?? []}::text[],
       ${s.vatNumber ?? ""}, ${s.iban ?? ""}, ${s.contactsIt ?? ""}, ${s.contactsEn ?? ""}, ${action},
       ${null}, ${[]}::text[], ${by?.id ?? null}, ${by?.name ?? null},
       ${new Date("2026-11-10T10:00:00.000Z")})`;
}

const GOOD = {
  legalName: "wellD SA",
  addressIt: ["Via Cantonale 1", "6900 Lugano"],
  addressEn: ["Via Cantonale 1", "6900 Lugano, Switzerland"],
  vatNumber: "CHE-123.456.789 IVA",
  iban: "CH9300762011623852957",
  contactsIt: "Tel. +41 91 000 00 00",
  contactsEn: "Phone +41 91 000 00 00",
};
const CH_PRINT = "CH93 0076 2011 6238 5295 7";
const IT_IBAN = "IT60X0542811101000000123456";
const IT_PRINT = "IT60 X054 2811 1010 0000 0123 456";

/** v1 incomplete import, v2 complete: the current version is 2. */
async function seedHistory(tx: Tx, entity: LegalEntity = "welld_ch", over: Partial<Seed> = {}) {
  await seed(tx, { entity, version: 1, legalName: "wellD SA", addressIt: ["Via Cantonale 1"] });
  await seed(tx, { entity, version: 2, ...GOOD, ...over });
}

const DETAILS = {
  legalName: GOOD.legalName,
  address: { it: GOOD.addressIt, en: GOOD.addressEn },
  vatNumber: GOOD.vatNumber,
  iban: GOOD.iban,
  contacts: { it: GOOD.contactsIt, en: GOOD.contactsEn },
};
const details = (over: Record<string, unknown> = {}) => ({ ...DETAILS, ...over });

type Requestable = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
const JSON_HEADERS = { "Content-Type": "application/json" };

function post(router: Requestable, path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) {
  return router.request(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const check = (router: Requestable, entity: string, body: unknown) => post(router, `/legal-entities/${entity}/versions/check`, body);
const save = (router: Requestable, entity: string, body: unknown) => post(router, `/legal-entities/${entity}/versions`, body);

/** Limits out of the way unless a test passes its own. */
const bigLimits = () => createLegalEntityRateLimits({ writeLimit: 1_000_000, checkLimit: 1_000_000 });
const checkRouter = (tx: Tx, limits = bigLimits()) => createLegalEntityCheckRouter({ client: tx, limits });

async function snapshot(tx: Tx) {
  return {
    versions: await tx.legalEntityVersion.findMany({ orderBy: [{ entity: "asc" }, { version: "asc" }] }),
    audit: await tx.auditLog.count({ where: { targetType: "legal_entity" } }),
  };
}

const advisoryLocksHeld = async (tx: Tx) =>
  Number(
    (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`)[0]?.n,
  );

async function okBody(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as {
    baseVersion: number;
    outcome: string;
    changedFields: string[];
    protectedChanges: { field: string; before: string; after: string }[];
  };
}

// ─── Authentication and authorisation ─────────────────────────────────────────────────────────────────────────────

describe("authentication and authorisation (the save's order, AC-4.2)", () => {
  test("no session: 401, no-store, nothing of the request in the body", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(null);
      for (const entity of ["welld_ch", "welld_de"]) {
        const res = await check(checkRouter(tx), entity, { baseVersion: 2, details: details({ legalName: "ECHOME SA" }) });
        expect(res.status).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).not.toContain("ECHOME");
      }
    });
  });

  test("no grant at all: 403 forbidden, one constant body whatever entity is named, the body is not looked at", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await makeUser("no-grant", "welld_ch"));
      const bodies = new Set<string>();
      for (const res of [
        await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details() }),
        await check(checkRouter(tx), "welld_it", { baseVersion: 2, details: details() }),
        await check(checkRouter(tx), "welld_de", { baseVersion: 2, details: details() }),
        await check(checkRouter(tx), "welld_ch", "not json at all"),
      ]) {
        expect(res.status).toBe(403);
        expect(res.headers.get("cache-control")).toBe("no-store");
        bodies.add(await res.text());
      }
      expect(Array.from(bodies)).toEqual([JSON.stringify(FORBIDDEN_BODY)]);
    });
  });

  test("an entity that is not one is 404 for a person with a grant; a grant that does not cover this entity is 403", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      await seedHistory(tx, "welld_it");
      signedInAs(await chManager("ch-only"));
      const unknown = await check(checkRouter(tx), "welld_de", { baseVersion: 2, details: details() });
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe(JSON.stringify(UNKNOWN_LEGAL_ENTITY_BODY));
      const other = await check(checkRouter(tx), "welld_it", { baseVersion: 2, details: details() });
      expect(other.status).toBe(403);
      expect(await other.text()).toBe(JSON.stringify(FORBIDDEN_BODY));
      expect((await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details() })).status).toBe(200);
    });
  });

  test("a soft-deleted holder with a live session, and a session whose user row is gone, are 403 forbidden", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const person = await admin("deleted-holder");
      signedInAs(person);
      await db.user.update({ where: { id: person.id }, data: { deletedAt: new Date() } });
      const bodies = new Set<string>();
      for (const entity of ["welld_ch", "welld_de"]) {
        const res = await check(checkRouter(tx), entity, { baseVersion: 2, details: details({ legalName: "Still Here SA" }) });
        expect(res.status).toBe(403);
        bodies.add(await res.text());
      }
      signedInAs({ id: `no-such-user-${RUN_ID}`, email: "ghost@legalentities.test", name: "Ghost" });
      const ghost = await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details() });
      expect(ghost.status).toBe(403);
      bodies.add(await ghost.text());
      expect(Array.from(bodies)).toEqual([JSON.stringify(FORBIDDEN_BODY)]);
    });
  });
});

// ─── The request ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("the request: 413 and 422 invalid_request", () => {
  const UNKNOWN_MEMBER = "zzSecretMemberName";

  test("a body over 16 KiB is 413 request_too_large", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("too-large"));
      const huge = JSON.stringify({ baseVersion: 2, details: details({ legalName: "x".repeat(MAX_WRITE_BODY_BYTES) }) });
      const res = await check(checkRouter(tx), "welld_ch", huge);
      expect(res.status).toBe(413);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(JSON.stringify(REQUEST_TOO_LARGE_BODY));
    });
  });

  test("not exactly the shape of the save is 422 invalid_request, one constant body, nothing echoed", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("shape"));
      const router = checkRouter(tx);
      const { legalName: _omit, ...withoutName } = DETAILS;
      const bodies: unknown[] = [
        "not json at all",
        "[]",
        "null",
        {},
        { baseVersion: 2 },
        { details: details() },
        { baseVersion: "2", details: details() },
        { baseVersion: 2.5, details: details() },
        { baseVersion: -1, details: details() },
        { baseVersion: 2 ** 31, details: details() },
        { baseVersion: 2, details: details(), [UNKNOWN_MEMBER]: 1 },
        { baseVersion: 2, details: { ...details(), [UNKNOWN_MEMBER]: 1 } },
        { baseVersion: 2, details: withoutName },
        { baseVersion: 2, details: details({ legalName: 7 }) },
        { baseVersion: 2, details: details({ address: { it: ["a"], en: ["b"], fr: [] } }) },
        { baseVersion: 2, details: details({ address: { it: Array.from({ length: 17 }, () => "x"), en: ["b"] } }) },
        { baseVersion: 2, details: details({ contacts: { it: "" } }) },
      ];
      for (const body of bodies) {
        const res = await check(router, "welld_ch", body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        expect(text).toBe(JSON.stringify(INVALID_REQUEST_BODY));
        expect(text).not.toContain(UNKNOWN_MEMBER);
      }
    });
  });

  test("a body that does not say it is JSON is 422 invalid_request (the CSRF posture of the save)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("content-type"));
      const body = JSON.stringify({ baseVersion: 2, details: details() });
      for (const headers of [{}, { "Content-Type": "text/plain" }, { "Content-Type": "application/x-www-form-urlencoded" }]) {
        const res = await post(checkRouter(tx), "/legal-entities/welld_ch/versions/check", body, headers);
        expect(res.status).toBe(422);
        expect(await res.text()).toBe(JSON.stringify(INVALID_REQUEST_BODY));
      }
    });
  });
});

describe("422 invalid_legal_entity: the problems a save would report, before any confirmation", () => {
  test("every problem at once, the very body of the save, nothing of the request echoed", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("problems"));
      const bad = details({
        legalName: "",
        address: { it: ["  ", ""], en: ["a", "b", "c", "d", "e"] },
        vatNumber: `SECRETVAT${"x".repeat(40)}`,
        iban: "CH00 SECRETIBAN",
      });
      const saveRouter = createLegalEntityWriteRouter({ limits: bigLimits(), client: tx });
      const dry = await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: bad });
      const real = await save(saveRouter, "welld_ch", { baseVersion: 2, details: bad });
      expect(dry.status).toBe(422);
      expect(dry.headers.get("cache-control")).toBe("no-store");
      const text = await dry.text();
      expect(text).toBe(await real.text());
      const parsed = JSON.parse(text) as { code: string; problems: { field: string; reason: string }[] };
      expect(parsed.code).toBe("invalid_legal_entity");
      expect(parsed.problems.map((p) => `${p.field}:${p.reason}`)).toEqual([
        "legalName:required",
        "address.it:required",
        "address.en:too_many_lines",
        "vatNumber:too_long",
        "iban:iban_format",
      ]);
      expect(text).not.toContain("SECRET");
    });
  });

  test("the 422 comes before the 409: an invalid body with a stale baseVersion, or on an entity not moved, is a 422", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("422-first"));
      const bad = details({ iban: "not an iban" });
      const stale = await check(checkRouter(tx), "welld_ch", { baseVersion: 1, details: bad });
      expect(stale.status).toBe(422);
      const notMoved = await check(checkRouter(tx), "welld_it", { baseVersion: 0, details: bad });
      expect(notMoved.status).toBe(422);
    });
  });
});

// ─── 409 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("409: not moved and version_conflict", () => {
  test("an entity with no version is 409 legal_entity_not_moved", async () => {
    await inTx(async (tx) => {
      signedInAs(await admin("not-moved"));
      const res = await check(checkRouter(tx), "welld_ch", { baseVersion: 0, details: details() });
      expect(res.status).toBe(409);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(JSON.stringify(NOT_MOVED_BODY));
    });
  });

  test("a baseVersion that is not current is 409 version_conflict + currentVersion, and shows no stored value", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx, "welld_ch", { legalName: "Stored Secret SA" });
      signedInAs(await admin("conflict"));
      for (const baseVersion of [0, 1, 3, 99]) {
        const res = await check(checkRouter(tx), "welld_ch", { baseVersion, details: details({ legalName: "Typed Secret SA" }) });
        expect(res.status).toBe(409);
        const text = await res.text();
        expect(JSON.parse(text)).toMatchObject({ code: "version_conflict", currentVersion: 2, status: 409 });
        expect(text).not.toContain("Secret");
      }
    });
  });
});

// ─── 200 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("200: what a save would change (AC-9.1, AC-9.5)", () => {
  test("an IBAN typed with spaces and lower case: one protected change, both sides in print form", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("iban"));
      const res = await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details({ iban: " it60 x054 2811 1010 0000 0123 456 " }) });
      expect(await okBody(res)).toEqual({
        baseVersion: 2,
        outcome: "change",
        changedFields: ["iban"],
        protectedChanges: [{ field: "iban", before: CH_PRINT, after: IT_PRINT }],
      });
    });
  });

  test("legal name and VAT are compared and shown trimmed and NFC; all three in closed-set order, other fields are not listed", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("three"));
      const res = await check(checkRouter(tx), "welld_ch", {
        baseVersion: 2,
        details: details({
          legalName: "  Società SA  ", // NFD, padded
          vatNumber: "　IT01234567890 ",
          iban: IT_IBAN,
          contacts: { it: "changed", en: GOOD.contactsEn },
        }),
      });
      expect(await okBody(res)).toEqual({
        baseVersion: 2,
        outcome: "change",
        changedFields: ["legalName", "vatNumber", "iban", "contacts.it"],
        protectedChanges: [
          { field: "legalName", before: "wellD SA", after: "Società SA" },
          { field: "vatNumber", before: "CHE-123.456.789 IVA", after: "IT01234567890" },
          { field: "iban", before: CH_PRINT, after: IT_PRINT },
        ],
      });
    });
  });

  test("emptying the IBAN is a protected change with \"\" as the new value; filling an empty one has \"\" as the old", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("empty"));
      const emptied = await okBody(await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details({ iban: "  " }) }));
      expect(emptied.protectedChanges).toEqual([{ field: "iban", before: CH_PRINT, after: "" }]);

      await seedHistory(tx, "welld_it", { iban: "" });
      const filled = await okBody(await check(checkRouter(tx), "welld_it", { baseVersion: 2, details: details({ iban: IT_IBAN }) }));
      expect(filled.protectedChanges).toEqual([{ field: "iban", before: "", after: IT_PRINT }]);
    });
  });

  test("IBAN spacing or case only: no protected change, and a no-op is outcome \"same\" (AC-9.5, AC-2.1)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("spacing"));
      for (const iban of ["ch93 0076 2011 6238 5295 7", "CH93 0076 2011\n6238 5295 7", CH_PRINT, "  ch9300762011623852957"]) {
        const body = await okBody(await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details({ iban }) }));
        expect(body).toEqual({ baseVersion: 2, outcome: "same", changedFields: [], protectedChanges: [] });
      }
      // Trailing blanks and blank address lines are the same value too.
      const same = await okBody(
        await check(checkRouter(tx), "welld_ch", {
          baseVersion: 2,
          details: details({ legalName: "wellD SA  ", address: { it: ["Via Cantonale 1", "", "6900 Lugano", "  "], en: GOOD.addressEn } }),
        }),
      );
      expect(same.outcome).toBe("same");
    });
  });

  test("an address-only or contacts-only change: outcome \"change\", the fields listed, protectedChanges []", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("others"));
      const address = await okBody(
        await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details({ address: { it: ["Via Nuova 3"], en: GOOD.addressEn } }) }),
      );
      expect(address).toEqual({ baseVersion: 2, outcome: "change", changedFields: ["address.it"], protectedChanges: [] });
      const contacts = await okBody(
        await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details({ contacts: { it: "", en: "Phone" } }) }),
      );
      expect(contacts).toEqual({ baseVersion: 2, outcome: "change", changedFields: ["contacts.it", "contacts.en"], protectedChanges: [] });
    });
  });

  test("the stored side is shown in the same normalised form as the typed side (an imported value in another spacing)", async () => {
    await inTx(async (tx) => {
      // An import may hold what the save never would; the check shows it the way a save would have stored it.
      await seedHistory(tx, "welld_ch", { legalName: "  wellD SA ", iban: "ch93 0076 2011 6238 5295 7" });
      signedInAs(await admin("imported"));
      const same = await okBody(await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details() }));
      expect(same.outcome).toBe("same");
      const other = await okBody(await check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details({ iban: IT_IBAN, legalName: "New SA" }) }));
      expect(other.protectedChanges).toEqual([
        { field: "legalName", before: "wellD SA", after: "New SA" },
        { field: "iban", before: CH_PRINT, after: IT_PRINT },
      ]);
    });
  });

  test("it answers for the entity of the path (the other entity's versions are not read)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx, "welld_ch");
      await seedHistory(tx, "welld_it", { legalName: "wellD Italia Srl" });
      signedInAs(await admin("per-entity"));
      const it = await okBody(await check(checkRouter(tx), "welld_it", { baseVersion: 2, details: details() }));
      expect(it.protectedChanges).toEqual([{ field: "legalName", before: "wellD Italia Srl", after: "wellD SA" }]);
    });
  });

  test("checkAnswer is pure: the same answer as the route's, and it never mutates its inputs", () => {
    const current = { ...DETAILS, address: { it: [...GOOD.addressIt], en: [...GOOD.addressEn] }, contacts: { ...DETAILS.contacts } };
    const frozen = structuredClone(current);
    const next = { ...structuredClone(current), iban: IT_IBAN };
    expect(checkAnswer(2, current, next)).toEqual({
      baseVersion: 2,
      outcome: "change",
      changedFields: ["iban"],
      protectedChanges: [{ field: "iban", before: CH_PRINT, after: IT_PRINT }],
    });
    expect(current).toEqual(frozen);
  });
});

// ─── Nothing is written ───────────────────────────────────────────────────────────────────────────────────────────

describe("read-only (AC-9.17): no version, no audit row, no advisory lock", () => {
  test("a check that would change everything writes no row and takes no advisory lock", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("read-only"));
      const before = await snapshot(tx);
      // The probe can see a lock (positive control): taking it by hand shows as one held by this connection.
      expect(await advisoryLocksHeld(tx)).toBe(0);
      const res = await check(checkRouter(tx), "welld_ch", {
        baseVersion: 2,
        details: details({ legalName: "Changed SA", iban: IT_IBAN, vatNumber: "IT1", contacts: { it: "x", en: "y" } }),
      });
      expect((await okBody(res)).outcome).toBe("change");
      expect(await advisoryLocksHeld(tx)).toBe(0);
      expect(await snapshot(tx)).toEqual(before);
      await lockEntity(tx, "welld_ch");
      expect(await advisoryLocksHeld(tx)).toBe(1);
    });
  });

  test("every refusal writes nothing either", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("refusals"));
      const before = await snapshot(tx);
      const router = checkRouter(tx);
      for (const res of [
        await check(router, "welld_ch", { baseVersion: 1, details: details({ legalName: "Stale SA" }) }),
        await check(router, "welld_ch", { baseVersion: 2, details: details({ legalName: "" }) }),
        await check(router, "welld_ch", "nope"),
        await check(router, "welld_it", { baseVersion: 0, details: details() }),
      ]) {
        expect(res.status).toBeGreaterThanOrEqual(409);
      }
      expect(await advisoryLocksHeld(tx)).toBe(0);
      expect(await snapshot(tx)).toEqual(before);
    });
  });

  test("it does not wait for the entity's advisory lock (a save holding it does not delay the dry run)", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("no-wait"));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = db.$transaction(
        async (other) => {
          await lockEntity(other, "welld_ch");
          held();
          await released;
        },
        { timeout: 30_000 },
      );
      await holding;
      try {
        const res = await Promise.race([
          check(checkRouter(tx), "welld_ch", { baseVersion: 2, details: details({ legalName: "While Locked SA" }) }),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
        ]);
        expect(res).not.toBe("blocked");
        expect((res as Response).status).toBe(200);
      } finally {
        release();
        await holder;
      }
    });
  });

  test("the route is built from reads only: no write call, no transaction, no lock in the module", () => {
    const source = readFileSync(join(import.meta.dir, "check.routes.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const forbidden of [/\.create\(/, /\.update\(/, /\.delete/, /\.upsert\(/, /\$transaction/, /\$executeRaw/, /withAudit/, /appendVersion/, /lockEntity/, /pg_advisory/]) {
      expect([String(forbidden), forbidden.test(source)]).toEqual([String(forbidden), false]);
    }
    // One pair of limiters for the app (plan G9): this module builds none.
    expect(source).not.toContain("createLegalEntityRateLimits(");
    expect(source).not.toContain("createSlidingWindowRateLimiter");
  });
});

// ─── The throttle ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the throttle (F3, plan G9): the check's own per-person window", () => {
  test("past the limit: 429 too_many_requests + Retry-After, counted before the body is read; another person is unaffected", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const person = await admin("throttled");
      const other = await admin("throttled-other");
      signedInAs(person);
      const router = checkRouter(tx, createLegalEntityRateLimits({ checkLimit: 3 }));
      for (let i = 0; i < 3; i++) expect((await check(router, "welld_ch", { baseVersion: 2, details: details() })).status).toBe(200);
      for (const res of [
        await check(router, "welld_ch", { baseVersion: 2, details: details() }),
        await check(router, "welld_ch", "not json at all"), // not even valid JSON is needed
        await check(router, "welld_ch", { baseVersion: 1, details: details({ iban: "bad" }) }),
      ]) {
        expect(res.status).toBe(429);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const retryAfter = Number(res.headers.get("retry-after"));
        expect(Number.isInteger(retryAfter)).toBe(true);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(600);
        expect(await res.text()).toBe(JSON.stringify(TOO_MANY_REQUESTS_BODY));
      }
      signedInAs(other);
      expect((await check(router, "welld_ch", { baseVersion: 2, details: details() })).status).toBe(200);
    });
  });

  test("a refusal that comes before it is not counted: 401, 403 and 404 spend nothing", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      const router = checkRouter(tx, createLegalEntityRateLimits({ checkLimit: 1 }));
      signedInAs(null);
      for (let i = 0; i < 4; i++) expect((await check(router, "welld_ch", { baseVersion: 2, details: details() })).status).toBe(401);
      signedInAs(await makeUser("throttle-no-grant", "welld_ch"));
      for (let i = 0; i < 4; i++) expect((await check(router, "welld_ch", { baseVersion: 2, details: details() })).status).toBe(403);
      const manager = await chManager("throttle-ch");
      signedInAs(manager);
      for (let i = 0; i < 4; i++) expect((await check(router, "welld_it", { baseVersion: 2, details: details() })).status).toBe(403);
      for (let i = 0; i < 4; i++) expect((await check(router, "welld_de", { baseVersion: 2, details: details() })).status).toBe(404);
      expect((await check(router, "welld_ch", { baseVersion: 2, details: details() })).status).toBe(200);
      expect((await check(router, "welld_ch", { baseVersion: 2, details: details() })).status).toBe(429);
    });
  });

  test("the check and the save have separate windows on one shared pair: spending one leaves the other whole", async () => {
    await inTx(async (tx) => {
      await seedHistory(tx);
      signedInAs(await admin("separate"));
      const limits = createLegalEntityRateLimits({ writeLimit: 1, checkLimit: 1 });
      const checker = createLegalEntityCheckRouter({ client: tx, limits });
      const saver = createLegalEntityWriteRouter({ client: tx, limits });
      expect((await check(checker, "welld_ch", { baseVersion: 2, details: details() })).status).toBe(200);
      expect((await check(checker, "welld_ch", { baseVersion: 2, details: details() })).status).toBe(429);
      // The save is not affected by the checks (it answers, here a refusal of its own: it is not 429).
      expect((await save(saver, "welld_ch", { baseVersion: 1, details: details() })).status).toBe(409);
      expect((await save(saver, "welld_ch", { baseVersion: 1, details: details() })).status).toBe(429);
    });
  });

  test("the app's check router and write router share ONE pair of limiters", () => {
    const writeSource = readFileSync(join(import.meta.dir, "write.routes.ts"), "utf8");
    expect(writeSource).toContain("export const legalEntityRateLimits = createLegalEntityRateLimits();");
    expect(writeSource).toContain("createLegalEntityWriteRouter({ limits: legalEntityRateLimits })");
    const checkSource = readFileSync(join(import.meta.dir, "check.routes.ts"), "utf8");
    expect(checkSource).toContain("limits = legalEntityRateLimits");
    expect(legalEntityRateLimits.check).not.toBe(legalEntityRateLimits.write);
  });
});

// ─── Failure and documentation ────────────────────────────────────────────────────────────────────────────────────

describe("an unexpected failure", () => {
  test("a failing read is a constant 500 and the log names no row or message", async () => {
    signedInAs(await admin("failure"));
    const failing = { $queryRaw: async () => { throw Object.assign(new Error("SECRETROW wellD SA CH9300762011623852957"), { code: "P2010" }); } };
    const router = createLegalEntityCheckRouter({ client: failing as never, limits: bigLimits() });
    const logged: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    try {
      const res = await check(router, "welld_ch", { baseVersion: 2, details: details() });
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(JSON.stringify(INTERNAL_BODY));
      expect(logged.join("\n")).toContain("P2010");
      expect(logged.join("\n")).not.toContain("SECRETROW");
      expect(logged.join("\n")).not.toContain("CH93");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the documentation", () => {
  test("the OpenAPI document describes the check with its body and refusals", () => {
    const doc = createLegalEntityCheckRouter().getOpenAPIDocument({ openapi: "3.0.0", info: { title: "t", version: "1" } });
    const op = doc.paths?.["/legal-entities/{entity}/versions/check"]?.post;
    expect(op).toBeDefined();
    for (const status of ["200", "401", "403", "404", "409", "413", "422", "429"]) expect(op?.responses).toHaveProperty(status);
    expect(Object.keys(doc.paths ?? {})).toEqual(["/legal-entities/{entity}/versions/check"]);
  });
});
