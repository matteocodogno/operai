/**
 * The person read API (T5; AC-1.1, AC-3.1, AC-3.4, AC-4.3; plan E2, E6) against REAL Postgres.
 *
 * Version rows are written and read inside ONE rolled-back transaction (`testDb.ts`: the table is Tier 1, a test
 * cannot remove what it commits), the router reading through that transaction. Users, roles and grants are
 * ordinary committed rows with a per-run suffix, removed in `afterAll` like `authz.routes.test.ts` does.
 * `auth.config` is mocked (the session source), everything else - router, middleware chain, resolver, coverage -
 * runs for real.
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

const { createLegalEntityReadRouter, UNKNOWN_LEGAL_ENTITY_BODY } = await import("./read.routes");

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();

async function makeUser(label: string, entity: string | null = null) {
  const user = await db.user.create({
    data: { name: `T5 fixture ${label}`, email: `t5-le-read-${label}-${RUN_ID}-${crypto.randomUUID()}@legalentities.test`, entity },
  });
  createdUserIds.add(user.id);
  return user;
}

async function grantManage(userId: string, conditions: Record<string, unknown> | null) {
  const role = await db.role.create({ data: { name: `t5-le-read-${RUN_ID}-${crypto.randomUUID()}` } });
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
  legalName?: string;
  addressIt?: string[];
  addressEn?: string[];
  vatNumber?: string;
  iban?: string;
  createdAt?: string;
}

/** A version row; version 1 is the system's import, later ones are a person's save (the table's CHECKs). */
async function seed(tx: Tx, s: Seed) {
  const action = s.version === 1 ? "import" : "save";
  const by = s.version === 1 ? null : "u-saver";
  await tx.$executeRaw`
    INSERT INTO legal_entity_version
      ("entity","version","legalName","addressIt","addressEn","vatNumber","iban","contactsIt","contactsEn",
       "action","changedFields","createdByUserId","createdByName","createdAt")
    VALUES (${s.entity}, ${s.version}, ${s.legalName ?? ""}, ${s.addressIt ?? []}::text[], ${s.addressEn ?? []}::text[],
       ${s.vatNumber ?? ""}, ${s.iban ?? ""}, '', '', ${action}, ARRAY[]::text[], ${by}, ${by},
       ${new Date(s.createdAt ?? "2026-11-17T10:00:00.000Z")})`;
}

const CH_V1: Seed = { entity: "welld_ch", version: 1, legalName: "old name", addressIt: ["old"], addressEn: ["old"], vatNumber: "OLD" };
const CH_V2: Seed = {
  entity: "welld_ch",
  version: 2,
  legalName: "wellD SA",
  addressIt: ["Via Cantonale 1", "6900 Lugano"],
  addressEn: ["Via Cantonale 1", "6900 Lugano"],
  vatNumber: "CHE-123.456.789 IVA",
  iban: "CH9300762011623852957",
  createdAt: "2026-11-17T10:12:00.000Z",
};

const get = (tx: Tx, path: string) => createLegalEntityReadRouter(tx).request(path);

describe("authentication (AC-3.1)", () => {
  test("no cookie/token: 401 on the list, an entity and manageable, never reaching the data, all no-store", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V1);
      signedInAs(null);
      for (const path of ["/legal-entities", "/legal-entities/welld_ch", "/legal-entities/manageable"]) {
        const res = await get(tx, path);
        expect(res.status).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).not.toContain("old name");
      }
    });
  });

  test("an unknown name without a session is 401, not a 404 (nothing to learn before signing in)", async () => {
    await inRolledBackTx(async (tx) => {
      signedInAs(null);
      expect((await get(tx, "/legal-entities/welld_de")).status).toBe(401);
    });
  });
});

describe("GET /legal-entities and /legal-entities/{entity} (AC-1.1, AC-3.1)", () => {
  test("a person with no role at all reads the list and one entity, IBAN included", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V1);
      await seed(tx, CH_V2);
      signedInAs(await makeUser("norole"));

      const list = await get(tx, "/legal-entities");
      expect(list.status).toBe(200);
      expect(list.headers.get("cache-control")).toBe("no-store");
      expect(list.headers.get("content-type")).toContain("application/json");
      const body = (await list.json()) as { items: Array<Record<string, unknown>> };
      // Always exactly the two entities; the one with no version is "not moved yet".
      expect(body.items.map((i) => [i.entity, i.version])).toEqual([
        ["welld_it", 0],
        ["welld_ch", 2],
      ]);
      expect(body.items[0]).toMatchObject({ updatedAt: null, complete: false, iban: "", ibanPrint: "" });
      expect(body.items[1]).toMatchObject({
        legalName: "wellD SA",
        iban: "CH9300762011623852957",
        ibanPrint: "CH93 0076 2011 6238 5295 7",
        updatedAt: "2026-11-17T10:12:00.000Z",
        complete: true,
        missing: [],
        invalid: [],
      });

      const one = await get(tx, "/legal-entities/welld_ch");
      expect(one.status).toBe(200);
      expect(one.headers.get("cache-control")).toBe("no-store");
      // The single answer is, byte for byte, the list's item.
      expect(await one.text()).toBe(JSON.stringify(body.items[1]));
    });
  });

  test("the current version is the highest, not the latest inserted or the first", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V2);
      await seed(tx, { ...CH_V1, legalName: "first" });
      signedInAs(await makeUser("highest"));
      const one = (await (await get(tx, "/legal-entities/welld_ch")).json()) as { version: number; legalName: string };
      expect(one.version).toBe(2);
      expect(one.legalName).toBe("wellD SA");
    });
  });

  test("an entity with no version yet answers version 0 with empty values and nothing invalid (200, not 404)", async () => {
    await inRolledBackTx(async (tx) => {
      signedInAs(await makeUser("unmoved"));
      const res = await get(tx, "/legal-entities/welld_it");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        entity: "welld_it",
        version: 0,
        updatedAt: null,
        legalName: "",
        address: { it: [], en: [] },
        vatNumber: "",
        iban: "",
        ibanPrint: "",
        contacts: { it: "", en: "" },
        complete: false,
        missing: ["legalName", "address.it", "address.en", "vatNumber"],
        invalid: [],
      });
    });
  });

  test("a moved value that breaks today's rules is returned as stored and reported in `invalid` with line and limit (E6)", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, {
        entity: "welld_it",
        version: 1,
        legalName: "wellD S.r.l.",
        addressIt: ["a", "b", "x".repeat(121), "d", "e"],
        addressEn: ["a"],
        vatNumber: "IT1",
        iban: "IT60X0542811101000000123457",
      });
      signedInAs(await makeUser("invalid"));
      const body = (await (await get(tx, "/legal-entities/welld_it")).json()) as {
        address: { it: string[] };
        iban: string;
        complete: boolean;
        invalid: unknown[];
      };
      expect(body.address.it).toHaveLength(5);
      expect(body.iban).toBe("IT60X0542811101000000123457");
      expect(body.complete).toBe(true);
      expect(body.invalid).toEqual([
        { field: "address.it", line: 2, reason: "too_long", limit: 120 },
        { field: "address.it", reason: "too_many_lines", limit: 4 },
        { field: "iban", reason: "iban_check_digits" },
      ]);
    });
  });
});

describe("an unknown entity name (AC-3.4)", () => {
  const names = ["welld_de", "%00", "x".repeat(300), "WELLD_CH", "welld_ch%20", "constructor", "__proto__", "%E0%A4%A", "%zz"];

  test("answers one fixed 404 body, identical for every name, that contains none of them", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V2);
      signedInAs(await makeUser("unknown"));
      const bodies = new Set<string>();
      for (const name of names) {
        const res = await get(tx, `/legal-entities/${name}`);
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        bodies.add(text);
        // The requested name (decoded or as sent) is never in the body, nor is any detail of an entity.
        expect(text).not.toContain(name);
        expect(text).not.toContain("wellD SA");
      }
      expect([...bodies]).toEqual([JSON.stringify(UNKNOWN_LEGAL_ENTITY_BODY)]);
      expect(JSON.parse([...bodies][0]!)).toMatchObject({ status: 404, code: "unknown_legal_entity" });
    });
  });

  test("the body has no `instance`: the request path would echo the name", () => {
    expect("instance" in UNKNOWN_LEGAL_ENTITY_BODY).toBe(false);
  });
});

describe("GET /legal-entities/manageable (AC-4.3, E2)", () => {
  test("a welld_ch-conditioned holder gets [welld_ch]; the answer is not a 404 and not an entity", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await makeUser("ch-manager", "welld_ch");
      await grantManage(user.id, { attributes: [{ key: "entity", match: "user" }] });
      signedInAs(user);
      const res = await get(tx, "/legal-entities/manageable");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ entities: ["welld_ch"] });
    });
  });

  test("without a grant: []", async () => {
    await inRolledBackTx(async (tx) => {
      signedInAs(await makeUser("no-grant", "welld_ch"));
      expect(await (await get(tx, "/legal-entities/manageable")).json()).toEqual({ entities: [] });
    });
  });

  test("an unconditioned holder gets both, in registry order, whatever their own entity", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await makeUser("everything", null);
      await grantManage(user.id, null);
      signedInAs(user);
      expect(await (await get(tx, "/legal-entities/manageable")).json()).toEqual({ entities: ["welld_it", "welld_ch"] });
    });
  });

  test("a conditioned holder with no entity, or an unrecognised condition, covers nothing (fail closed)", async () => {
    await inRolledBackTx(async (tx) => {
      const noEntity = await makeUser("conditioned-no-entity", null);
      await grantManage(noEntity.id, { attributes: [{ key: "entity", match: "user" }] });
      signedInAs(noEntity);
      expect(await (await get(tx, "/legal-entities/manageable")).json()).toEqual({ entities: [] });

      const odd = await makeUser("odd-condition", "welld_ch");
      await grantManage(odd.id, { ownership: "own" });
      signedInAs(odd);
      expect(await (await get(tx, "/legal-entities/manageable")).json()).toEqual({ entities: [] });
    });
  });

  test("is registered before /{entity}: the router resolves the literal path to its own handler", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx, CH_V2);
      signedInAs(await makeUser("order"));
      const body = (await (await get(tx, "/legal-entities/manageable")).json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["entities"]);
      // Only the exact, lower-case segment is reserved.
      expect((await get(tx, "/legal-entities/Manageable")).status).toBe(404);
    });
  });

  test("the order survives mounting the router in a parent app, as index.ts does", async () => {
    await inRolledBackTx(async (tx) => {
      signedInAs(await makeUser("mounted"));
      const parent = new OpenAPIHono();
      parent.route("/", createLegalEntityReadRouter(tx));
      const res = await parent.request("/legal-entities/manageable");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ entities: [] });
    });
  });
});

describe("the module only reads", () => {
  test("no route other than GET is declared by this router", () => {
    const methods = new Set(createLegalEntityReadRouter().routes.map((r) => r.method));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(methods.has(method)).toBe(false);
  });
});
