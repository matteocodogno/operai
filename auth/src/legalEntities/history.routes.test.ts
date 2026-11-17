/**
 * The history and the version view (T7; AC-2.2, AC-2.3, AC-2.4, AC-4.3, AC-7.2; plan E1) against REAL Postgres.
 *
 * As `read.routes.test.ts`: version rows are written and read inside ONE rolled-back transaction (the table is
 * Tier 1), users, roles and grants are ordinary committed rows with a per-run suffix removed in `afterAll`, and
 * only `auth.config` (the session source) is mocked.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { inRolledBackTx, type Tx } from "./testDb";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;

mock.module("../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession) } },
}));

const { createLegalEntityHistoryRouter, FORBIDDEN_BODY, parseVersion, VERSION_NOT_FOUND_BODY } = await import(
  "./history.routes"
);
const { createLegalEntityReadRouter, UNKNOWN_LEGAL_ENTITY_BODY } = await import("./read.routes");

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();

async function makeUser(label: string, entity: string | null = null) {
  const user = await db.user.create({
    data: { name: `T7 fixture ${label}`, email: `t7-le-hist-${label}-${RUN_ID}-${crypto.randomUUID()}@legalentities.test`, entity },
  });
  createdUserIds.add(user.id);
  return user;
}

async function grantManage(userId: string, conditions: Record<string, unknown> | null) {
  const role = await db.role.create({ data: { name: `t7-le-hist-${RUN_ID}-${crypto.randomUUID()}` } });
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

/** A welld_ch-only manager: the entity-conditioned grant of the seed. */
async function chManager(label: string) {
  const user = await makeUser(label, "welld_ch");
  await grantManage(user.id, { attributes: [{ key: "entity", match: "user" }] });
  return user;
}

function signedInAs(user: { id: string; email: string; name: string } | null) {
  currentSession = user === null ? null : { user, session: { id: `sess-${user.id}` } };
}

afterAll(async () => {
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

interface Seed {
  entity: "welld_it" | "welld_ch";
  version: number;
  action?: "import" | "save" | "restore";
  restoredFrom?: number | null;
  changedFields?: string[];
  by?: { id: string; name: string } | null;
  legalName?: string;
  addressIt?: string[];
  addressEn?: string[];
  vatNumber?: string;
  iban?: string;
  contactsIt?: string;
  contactsEn?: string;
  createdAt?: string;
}

/** A version row; defaults follow the table's CHECKs (version 1 = the system's import, later = a person's save). */
async function seed(tx: Tx, s: Seed) {
  const action = s.action ?? (s.version === 1 ? "import" : "save");
  const by = s.by !== undefined ? s.by : action === "import" ? null : { id: "u-saver", name: "Sara Saver" };
  await tx.$executeRaw`
    INSERT INTO legal_entity_version
      ("entity","version","legalName","addressIt","addressEn","vatNumber","iban","contactsIt","contactsEn",
       "action","restoredFrom","changedFields","createdByUserId","createdByName","createdAt")
    VALUES (${s.entity}, ${s.version}, ${s.legalName ?? ""}, ${s.addressIt ?? []}::text[], ${s.addressEn ?? []}::text[],
       ${s.vatNumber ?? ""}, ${s.iban ?? ""}, ${s.contactsIt ?? ""}, ${s.contactsEn ?? ""}, ${action},
       ${s.restoredFrom ?? null}, ${s.changedFields ?? []}::text[], ${by?.id ?? null}, ${by?.name ?? null},
       ${new Date(s.createdAt ?? "2026-11-17T10:00:00.000Z")})`;
}

const GOOD = {
  legalName: "wellD SA",
  addressIt: ["Via Cantonale 1", "6900 Lugano"],
  addressEn: ["Via Cantonale 1", "6900 Lugano"],
  vatNumber: "CHE-123.456.789 IVA",
  iban: "CH9300762011623852957",
};

/** v1 import (incomplete: no VAT, no English address), v2 save (complete), v3 save (bad IBAN), v4 restore of 2. */
async function seedChHistory(tx: Tx) {
  await seed(tx, {
    entity: "welld_ch",
    version: 1,
    legalName: "wellD SA",
    addressIt: ["Via Cantonale 1"],
    changedFields: ["legalName", "address.it"],
    createdAt: "2026-11-01T08:00:00.000Z",
  });
  await seed(tx, {
    entity: "welld_ch",
    version: 2,
    ...GOOD,
    contactsIt: "Tel. +41 91",
    changedFields: ["address.en", "vatNumber", "iban", "contacts.it"],
    createdAt: "2026-11-05T09:30:00.000Z",
  });
  await seed(tx, {
    entity: "welld_ch",
    version: 3,
    ...GOOD,
    iban: "CH9300762011623852958", // bad check digits, as a moved value could be
    changedFields: ["iban"],
    by: { id: "u-other", name: "Otto Other" },
    createdAt: "2026-11-10T14:00:00.000Z",
  });
  await seed(tx, {
    entity: "welld_ch",
    version: 4,
    ...GOOD,
    contactsIt: "Tel. +41 91",
    action: "restore",
    restoredFrom: 2,
    changedFields: ["iban"],
    createdAt: "2026-11-12T16:45:00.000Z",
  });
}

const get = (tx: Tx, path: string) => createLegalEntityHistoryRouter(tx).request(path);

describe("authentication", () => {
  test("no session: 401 on both routes, no-store, nothing of the data in the body", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(null);
      for (const path of ["/legal-entities/welld_ch/versions", "/legal-entities/welld_ch/versions/2", "/legal-entities/welld_de/versions"]) {
        const res = await get(tx, path);
        expect(res.status).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).not.toContain("wellD SA");
      }
    });
  });
});

describe("403 forbidden without a covering grant (AC-4.2, AC-4.3)", () => {
  test("a signed-in person with no grant, on both routes: one constant body, no-store, no data", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await makeUser("no-grant", "welld_ch"));
      const bodies = new Set<string>();
      for (const path of [
        "/legal-entities/welld_ch/versions",
        "/legal-entities/welld_it/versions",
        "/legal-entities/welld_ch/versions/2",
        "/legal-entities/welld_ch/versions/999",
        // The refusal comes before anything about the entity or the version is looked at.
        "/legal-entities/welld_de/versions",
        "/legal-entities/welld_de/versions/abc",
      ]) {
        const res = await get(tx, path);
        expect(res.status).toBe(403);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        const text = await res.text();
        expect(text).not.toContain("wellD SA");
        expect(text).not.toContain("welld_de");
        bodies.add(text);
      }
      expect([...bodies]).toEqual([JSON.stringify(FORBIDDEN_BODY)]);
      expect(FORBIDDEN_BODY).toMatchObject({ status: 403, code: "forbidden" });
      expect("instance" in FORBIDDEN_BODY).toBe(false);
    });
  });

  test("a conditioned grant that covers nothing (no entity on the person, an unknown condition) is 403 (fail closed)", async () => {
    await inRolledBackTx(async (tx) => {
      const noEntity = await makeUser("cond-no-entity", null);
      await grantManage(noEntity.id, { attributes: [{ key: "entity", match: "user" }] });
      signedInAs(noEntity);
      expect((await get(tx, "/legal-entities/welld_ch/versions")).status).toBe(403);

      const odd = await makeUser("cond-odd", "welld_ch");
      await grantManage(odd.id, { ownership: "own" });
      signedInAs(odd);
      expect((await get(tx, "/legal-entities/welld_ch/versions")).status).toBe(403);
    });
  });

  test("a different permission (not legal-entity:manage) opens nothing", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await makeUser("other-perm", "welld_ch");
      const role = await db.role.create({ data: { name: `t7-le-hist-${RUN_ID}-${crypto.randomUUID()}` } });
      createdRoleIds.add(role.id);
      await db.permissionRule.create({ data: { roleId: role.id, resource: "legal-entity", action: "read" } });
      await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
      signedInAs(user);
      expect((await get(tx, "/legal-entities/welld_ch/versions")).status).toBe(403);
    });
  });
});

describe("a welld_ch-only manager reads both histories (AC-4.3)", () => {
  test("the list and the version view of the entity they manage and of the other one", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      await seed(tx, { entity: "welld_it", version: 1, legalName: "wellD S.r.l.", addressIt: ["Via Roma 1"], addressEn: ["Via Roma 1"], vatNumber: "IT1" });
      signedInAs(await chManager("ch-only"));

      for (const [entity, expected] of [
        ["welld_ch", [4, 3, 2, 1]],
        ["welld_it", [1]],
      ] as const) {
        const res = await get(tx, `/legal-entities/${entity}/versions`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = (await res.json()) as { items: Array<{ version: number }> };
        expect(body.items.map((i) => i.version)).toEqual([...expected]);

        const view = await get(tx, `/legal-entities/${entity}/versions/1`);
        expect(view.status).toBe(200);
        expect(((await view.json()) as { entity: string }).entity).toBe(entity);
      }
    });
  });

  test("an unconditioned manager reads both too", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      const user = await makeUser("everything", null);
      await grantManage(user.id, null);
      signedInAs(user);
      expect((await get(tx, "/legal-entities/welld_ch/versions")).status).toBe(200);
      expect((await get(tx, "/legal-entities/welld_it/versions")).status).toBe(200);
    });
  });
});

describe("GET /legal-entities/{entity}/versions (AC-2.2, AC-7.2, E1)", () => {
  test("every version, newest first, with the record of how each came to be, in the contract's key order", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await chManager("order"));
      const res = await get(tx, "/legal-entities/welld_ch/versions");
      const body = (await res.json()) as { items: Array<Record<string, unknown>>; nextBefore: number | null };
      expect(Object.keys(body)).toEqual(["items", "nextBefore"]);
      expect(body.nextBefore).toBeNull();
      expect(body.items.map((i) => i.version)).toEqual([4, 3, 2, 1]);
      expect(Object.keys(body.items[0]!)).toEqual([
        "version",
        "action",
        "restoredFrom",
        "createdBy",
        "createdAt",
        "changedFields",
        "restorable",
      ]);
      expect(body.items).toEqual([
        {
          version: 4,
          action: "restore",
          restoredFrom: 2,
          createdBy: { id: "u-saver", name: "Sara Saver" },
          createdAt: "2026-11-12T16:45:00.000Z",
          changedFields: ["iban"],
          restorable: true,
        },
        {
          version: 3,
          action: "save",
          restoredFrom: null,
          createdBy: { id: "u-other", name: "Otto Other" },
          createdAt: "2026-11-10T14:00:00.000Z",
          changedFields: ["iban"],
          restorable: false,
        },
        {
          version: 2,
          action: "save",
          restoredFrom: null,
          createdBy: { id: "u-saver", name: "Sara Saver" },
          createdAt: "2026-11-05T09:30:00.000Z",
          changedFields: ["address.en", "vatNumber", "iban", "contacts.it"],
          restorable: true,
        },
        {
          version: 1,
          action: "import",
          restoredFrom: null,
          createdBy: null,
          createdAt: "2026-11-01T08:00:00.000Z",
          changedFields: ["legalName", "address.it"],
          restorable: false,
        },
      ]);
    });
  });

  test("`createdBy` is null for the import (the system) and only for it", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await chManager("system"));
      const { items } = (await (await get(tx, "/legal-entities/welld_ch/versions")).json()) as {
        items: Array<{ action: string; createdBy: unknown }>;
      };
      expect(items.filter((i) => i.createdBy === null).map((i) => i.action)).toEqual(["import"]);
    });
  });

  test("`changedFields` is returned as stored, not recomputed from the details", async () => {
    await inRolledBackTx(async (tx) => {
      // Stored list that disagrees with the details (v2 equals v1): whatever was written is what is read.
      await seed(tx, { entity: "welld_it", version: 1, ...GOOD, changedFields: ["legalName", "iban"] });
      await seed(tx, { entity: "welld_it", version: 2, ...GOOD, changedFields: ["contacts.en", "vatNumber"] });
      signedInAs(await chManager("as-stored"));
      const { items } = (await (await get(tx, "/legal-entities/welld_it/versions")).json()) as {
        items: Array<{ changedFields: string[] }>;
      };
      expect(items.map((i) => i.changedFields)).toEqual([["contacts.en", "vatNumber"], ["legalName", "iban"]]);
    });
  });

  test("`restorable` is true exactly when the details pass today's rules, the current version included (E1)", async () => {
    await inRolledBackTx(async (tx) => {
      const e = "welld_it" as const;
      await seed(tx, { entity: e, version: 1, ...GOOD, vatNumber: "" }); // incomplete (VAT)
      await seed(tx, { entity: e, version: 2, ...GOOD, addressEn: [] }); // incomplete (address.en)
      await seed(tx, { entity: e, version: 3, ...GOOD, addressIt: ["a", "b", "c", "d", "e"] }); // too many lines
      await seed(tx, { entity: e, version: 4, ...GOOD, legalName: "x".repeat(201) }); // too long
      await seed(tx, { entity: e, version: 5, ...GOOD, contactsEn: "line\nbreak" }); // line break
      await seed(tx, { entity: e, version: 6, ...GOOD, iban: "CH93 0076" }); // not an IBAN
      await seed(tx, { entity: e, version: 7, ...GOOD, iban: "" }); // IBAN is optional: fine
      await seed(tx, { entity: e, version: 8, ...GOOD }); // current, fine
      signedInAs(await chManager("restorable"));
      const { items } = (await (await get(tx, `/legal-entities/${e}/versions`)).json()) as {
        items: Array<{ version: number; restorable: boolean }>;
      };
      expect(items.map((i) => [i.version, i.restorable])).toEqual([
        [8, true],
        [7, true],
        [6, false],
        [5, false],
        [4, false],
        [3, false],
        [2, false],
        [1, false],
      ]);
    });
  });

  test("an entity with no version yet has an empty history (200, not 404)", async () => {
    await inRolledBackTx(async (tx) => {
      signedInAs(await chManager("empty"));
      const res = await get(tx, "/legal-entities/welld_it/versions");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [], nextBefore: null });
    });
  });

  test("one entity's history never contains the other's versions", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, { entity: "welld_ch", version: 1, ...GOOD });
      await seed(tx, { entity: "welld_it", version: 1, ...GOOD, legalName: "ITALIA" });
      await seed(tx, { entity: "welld_it", version: 2, ...GOOD, legalName: "ITALIA 2" });
      signedInAs(await chManager("separate"));
      const { items } = (await (await get(tx, "/legal-entities/welld_ch/versions")).json()) as { items: unknown[] };
      expect(items).toHaveLength(1);
    });
  });

  test("an unknown entity name, for a manager: the fixed 404 of AC-3.4, nothing echoed", async () => {
    await inRolledBackTx(async (tx) => {
      signedInAs(await chManager("unknown"));
      const bodies = new Set<string>();
      for (const name of ["welld_de", "manageable", "WELLD_CH", "x".repeat(300), "%00"]) {
        const res = await get(tx, `/legal-entities/${name}/versions`);
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        bodies.add(await res.text());
      }
      expect([...bodies]).toEqual([JSON.stringify(UNKNOWN_LEGAL_ENTITY_BODY)]);
    });
  });
});

describe("paging (F3, plan G5)", () => {
  /** Versions 1..n of welld_ch: one import and n-1 saves, all with a valid shape. */
  async function seedMany(tx: Tx, n: number) {
    for (let v = 1; v <= n; v++) await seed(tx, { entity: "welld_ch", version: v, ...GOOD, changedFields: ["legalName"] });
  }
  type Page = { items: Array<{ version: number }>; nextBefore: number | null };
  const page = async (tx: Tx, query = "") => {
    const res = await get(tx, `/legal-entities/welld_ch/versions${query}`);
    return { res, body: (await res.json()) as Page };
  };

  test("pages of 50, newest first, `before` is the cursor, `nextBefore` is null on the last page, the pages are every version", async () => {
    await inRolledBackTx(async (tx) => {
      await seedMany(tx, 120);
      signedInAs(await chManager("paging"));
      const seen: number[] = [];
      const sizes: number[] = [];
      let query = "";
      for (let guard = 0; guard < 10; guard++) {
        const { res, body } = await page(tx, query);
        expect(res.status).toBe(200);
        sizes.push(body.items.length);
        seen.push(...body.items.map((i) => i.version));
        if (body.nextBefore === null) break;
        // The cursor is the oldest version of this page: the next page is everything below it.
        expect(body.nextBefore).toBe(body.items[body.items.length - 1]!.version);
        query = `?before=${body.nextBefore}`;
      }
      expect(sizes).toEqual([50, 50, 20]);
      expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => 120 - i));
    });
  });

  test("`limit` sets the page; a full last page has no next one; exactly `limit` versions left is the last page", async () => {
    await inRolledBackTx(async (tx) => {
      await seedMany(tx, 10);
      signedInAs(await chManager("limit"));
      expect((await page(tx, "?limit=3")).body).toMatchObject({ nextBefore: 8, items: [{ version: 10 }, { version: 9 }, { version: 8 }] });
      expect((await page(tx, "?limit=3&before=8")).body.nextBefore).toBe(5);
      const last = (await page(tx, "?limit=3&before=2")).body;
      expect(last.items.map((i) => i.version)).toEqual([1]);
      expect(last.nextBefore).toBeNull();
      const exact = (await page(tx, "?limit=10")).body;
      expect(exact.items).toHaveLength(10);
      expect(exact.nextBefore).toBeNull();
      expect((await page(tx, "?limit=100")).body.items).toHaveLength(10);
      expect((await page(tx, "?limit=1")).body.nextBefore).toBe(10);
      // A cursor past the oldest version is an empty last page, not an error.
      expect((await page(tx, "?before=1")).body).toEqual({ items: [], nextBefore: null });
    });
  });

  test("a `limit` or `before` that is not accepted, or any other member, is 422 invalid_request after the 403s, nothing echoed", async () => {
    await inRolledBackTx(async (tx) => {
      await seedMany(tx, 3);
      const bad = [
        "?limit=0", "?limit=101", "?limit=abc", "?limit=", "?limit=-1", "?limit=1.5", "?limit=05", "?limit=1&limit=2",
        "?before=abc", "?before=0", "?before=", "?before=99999999999999999999", "?before=1&before=2",
        "?extra=1", "?limit=5&zzSecretMember=1", "?LIMIT=5",
      ];
      signedInAs(await chManager("bad-query"));
      for (const query of bad) {
        const res = await get(tx, `/legal-entities/welld_ch/versions${query}`);
        expect(res.status).toBe(422);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        expect(JSON.parse(text)).toMatchObject({ status: 422, code: "invalid_request" });
        expect(text).not.toContain("zzSecret");
        expect(text).not.toContain("abc");
      }
      // The 403 and the 404 come first: a person with no grant, or an unknown entity, is not told about the query.
      signedInAs(await makeUser("bad-query-no-grant", "welld_ch"));
      const forbidden = await get(tx, "/legal-entities/welld_ch/versions?limit=0");
      expect(forbidden.status).toBe(403);
      expect(await forbidden.text()).toBe(JSON.stringify(FORBIDDEN_BODY));
      signedInAs(await chManager("bad-query-404"));
      expect((await get(tx, "/legal-entities/welld_de/versions?limit=0")).status).toBe(404);
    });
  });
});

describe("a deleted person (F2)", () => {
  test("a soft-deleted holder with a live session is 403 forbidden on the history and the version view", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      const person = await chManager("deleted");
      signedInAs(person);
      expect((await get(tx, "/legal-entities/welld_ch/versions")).status).toBe(200);
      await db.user.update({ where: { id: person.id }, data: { deletedAt: new Date() } });
      const bodies = new Set<string>();
      for (const path of ["/legal-entities/welld_ch/versions", "/legal-entities/welld_it/versions", "/legal-entities/welld_ch/versions/2", "/legal-entities/welld_de/versions"]) {
        const res = await get(tx, path);
        expect(res.status).toBe(403);
        expect(res.headers.get("cache-control")).toBe("no-store");
        bodies.add(await res.text());
      }
      expect([...bodies]).toEqual([JSON.stringify(FORBIDDEN_BODY)]);
    });
  });
});

describe("GET /legal-entities/{entity}/versions/{n} (AC-2.3, AC-2.4, AC-7.2)", () => {
  test("all the details of version n plus action, restoredFrom, createdBy and createdAt", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await chManager("view"));
      const res = await get(tx, "/legal-entities/welld_ch/versions/2");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        entity: "welld_ch",
        version: 2,
        updatedAt: "2026-11-05T09:30:00.000Z",
        legalName: "wellD SA",
        address: { it: ["Via Cantonale 1", "6900 Lugano"], en: ["Via Cantonale 1", "6900 Lugano"] },
        vatNumber: "CHE-123.456.789 IVA",
        iban: "CH9300762011623852957",
        ibanPrint: "CH93 0076 2011 6238 5295 7",
        contacts: { it: "Tel. +41 91", en: "" },
        complete: true,
        missing: [],
        invalid: [],
        action: "save",
        restoredFrom: null,
        createdBy: { id: "u-saver", name: "Sara Saver" },
        createdAt: "2026-11-05T09:30:00.000Z",
      });
    });
  });

  test("the LegalEntity part is the serializer's, byte for byte, for an older version (not the current one)", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await chManager("serializer"));
      const view = (await (await get(tx, "/legal-entities/welld_ch/versions/3")).json()) as Record<string, unknown>;
      // Version 3 is not the current one (4 is); its own invalid member is reported, as on a read (E6).
      expect(view.version).toBe(3);
      expect(view.invalid).toEqual([{ field: "iban", reason: "iban_check_digits" }]);
      expect(Object.keys(view)).toEqual([
        "entity", "version", "updatedAt", "legalName", "address", "vatNumber", "iban", "ibanPrint", "contacts",
        "complete", "missing", "invalid", "action", "restoredFrom", "createdBy", "createdAt",
      ]);
    });
  });

  test("the import: action import, createdBy null; a restore: restoredFrom set; an incomplete one lists `missing`", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await chManager("import-view"));
      const v1 = (await (await get(tx, "/legal-entities/welld_ch/versions/1")).json()) as Record<string, unknown>;
      expect(v1).toMatchObject({
        action: "import",
        restoredFrom: null,
        createdBy: null,
        complete: false,
        missing: ["address.en", "vatNumber"],
      });
      const v4 = (await (await get(tx, "/legal-entities/welld_ch/versions/4")).json()) as Record<string, unknown>;
      expect(v4).toMatchObject({ action: "restore", restoredFrom: 2 });
    });
  });

  test("a version that does not exist: 404 version_not_found, one constant body, nothing echoed", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await chManager("missing-version"));
      const bodies = new Set<string>();
      for (const n of [
        "5", // beyond the highest
        "0",
        "-1",
        "01",
        "1.5",
        "1e1",
        "0x2",
        "abc",
        "%202",
        "2%20",
        "2147483648", // just over an int4
        "99999999999999999999999", // would be an out-of-range parameter, never reaches SQL
        "9".repeat(300),
        "%00",
      ]) {
        const res = await get(tx, `/legal-entities/welld_ch/versions/${n}`);
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        const text = await res.text();
        expect(text).not.toContain("wellD SA");
        bodies.add(text);
      }
      expect([...bodies]).toEqual([JSON.stringify(VERSION_NOT_FOUND_BODY)]);
      expect(VERSION_NOT_FOUND_BODY).toMatchObject({ status: 404, code: "version_not_found" });
      expect("instance" in VERSION_NOT_FOUND_BODY).toBe(false);
    });
  });

  test("a version of the other entity is not found under this one", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, { entity: "welld_ch", version: 1, ...GOOD });
      await seed(tx, { entity: "welld_ch", version: 2, ...GOOD });
      await seed(tx, { entity: "welld_it", version: 1, ...GOOD });
      signedInAs(await chManager("cross"));
      expect((await get(tx, "/legal-entities/welld_it/versions/2")).status).toBe(404);
      expect((await get(tx, "/legal-entities/welld_it/versions/1")).status).toBe(200);
    });
  });

  test("an unknown entity name, for a manager, is the fixed unknown_legal_entity 404 (not version_not_found)", async () => {
    await inRolledBackTx(async (tx) => {
      signedInAs(await chManager("unknown-view"));
      const res = await get(tx, "/legal-entities/welld_de/versions/1");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(JSON.stringify(UNKNOWN_LEGAL_ENTITY_BODY));
    });
  });

  test("the highest version of the view is the one the person route calls current", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await chManager("same-as-current"));
      const view = (await (await get(tx, "/legal-entities/welld_ch/versions/4")).json()) as Record<string, unknown>;
      const current = (await (await createLegalEntityReadRouter(tx).request("/legal-entities/welld_ch")).json()) as Record<string, unknown>;
      const { action, restoredFrom, createdBy, createdAt, ...entityPart } = view;
      expect([action, restoredFrom, createdBy, createdAt]).toEqual(["restore", 2, { id: "u-saver", name: "Sara Saver" }, "2026-11-12T16:45:00.000Z"]);
      expect(entityPart).toEqual(current);
    });
  });
});

describe("parseVersion", () => {
  test("accepts canonical whole numbers that fit an int4, nothing else", () => {
    expect(parseVersion("1")).toBe(1);
    expect(parseVersion("2147483647")).toBe(2147483647);
    for (const bad of ["", "0", "-1", "+1", "01", "1.0", "1e3", " 1", "1 ", "2147483648", "٣", "NaN", "Infinity"]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });
});

describe("the module only reads, and does not shadow the other routes", () => {
  test("no route other than GET is declared by this router", () => {
    const methods = new Set(createLegalEntityHistoryRouter().routes.map((r) => r.method));
    expect([...methods]).toEqual(["GET"]);
  });

  test("a POST on these paths is not answered by this router (T8 owns it), and carries no authentication of ours", async () => {
    signedInAs(null);
    const router = createLegalEntityHistoryRouter();
    for (const path of ["/legal-entities/welld_ch/versions", "/legal-entities/welld_ch/versions/2/restore"]) {
      expect((await router.request(path, { method: "POST" })).status).toBe(404);
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect((await router.request("/legal-entities/welld_ch/versions/2", { method })).status).toBe(404);
    }
  });

  test("mounted beside the read router, as index.ts does, each answers its own paths", async () => {
    await inRolledBackTx(async (tx) => {
      await seedChHistory(tx);
      signedInAs(await chManager("mounted"));
      const parent = new OpenAPIHono();
      parent.route("/", createLegalEntityReadRouter(tx));
      parent.route("/", createLegalEntityHistoryRouter(tx));
      expect((await parent.request("/legal-entities/welld_ch")).status).toBe(200);
      expect((await parent.request("/legal-entities/manageable")).status).toBe(200);
      expect((await parent.request("/legal-entities/welld_ch/versions")).status).toBe(200);
      expect((await parent.request("/legal-entities/welld_ch/versions/1")).status).toBe(200);
    });
  });
});
