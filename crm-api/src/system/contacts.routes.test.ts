/**
 * GET /system/contacts (specs/022-projects-handoff T21, AC-3.6, AC-3.8, AC-3.9; T18 M2, L3, L8):
 * the CRM's contacts read service-to-service by projects-api with a scoped service credential
 * (`crm.contacts.read`) — the referent picker (`companyId` mode) and the referent's details on a
 * purchase order (`ids` mode), for users who may hold no `crm:access`. Real Postgres (`crm_test`);
 * the JWKS is an in-memory one injected into the middleware, so no live `auth` is needed.
 *
 * One shape per mode, built with an explicit `select`: the exact key set of each is pinned here, so
 * a contact's notes, audit fields or version can never leak by accident, and the bulk mode never
 * carries email or phone (M2). Every contact below is synthetic (L2).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { TEST_AUDIENCE, TEST_ISSUER } from "../test-support/testAuth";

const { db } = await import("../lib/db");
const { createSystemAuthMiddleware } = await import("./systemAuth.middleware");
const { createSystemContactsRouter, CONTACTS_LIMIT, MAX_CONTACT_IDS } = await import("./contacts.routes");

const SERVICE_AUD = "operai-system-test";
const KID = "svc-contacts-kid";
const RUN = crypto.randomUUID().slice(0, 8);
const PREFIX = `svc-contact-${RUN}`;
const URL_PATH = "/system/contacts";
const SCOPE = "crm.contacts.read";
const NOTES = `secret-notes-${RUN}`;
const AUDITOR = `auditor-${RUN}`;

let signingKey: CryptoKey;
let app: Hono;
let noAudienceApp: Hono;
let companyId: string;
let otherCompanyId: string;

const serviceJwt = (
  o: { sub?: string; scope?: string | null; aud?: string; exp?: string | number } = {},
): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (o.scope !== null) claims["scope"] = o.scope ?? SCOPE;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setAudience(o.aud ?? SERVICE_AUD)
    .setSubject(o.sub ?? "system:projects-api")
    .setExpirationTime(o.exp ?? "5m")
    .sign(signingKey);
};

const get = (query = "", token?: string, target: Hono = app) =>
  target.request(`${URL_PATH}${query}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});

interface ContactRow {
  id: string;
  companyId: string | null;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  archived: boolean;
}
type CompanyItem = Pick<ContactRow, "id" | "firstName" | "lastName" | "jobTitle">;

const makeCompany = (name: string) =>
  db.company.create({
    data: {
      name: `${PREFIX} ${name}`,
      status: "prospect",
      entity: "welld_ch",
      ownerUserId: "user-owner",
      createdBy: "user-owner",
      updatedBy: "user-owner",
    },
  });

const makeContact = (
  o: {
    companyId?: string | null;
    firstName?: string;
    lastName?: string;
    jobTitle?: string | null;
    archived?: boolean;
  } = {},
) =>
  db.contact.create({
    data: {
      companyId: o.companyId === undefined ? companyId : o.companyId,
      firstName: o.firstName ?? "Test",
      lastName: o.lastName ?? "Contact",
      jobTitle: o.jobTitle === undefined ? "Synthetic referent" : o.jobTitle,
      email: `${PREFIX}@example.test`,
      phone: "+00 000 000 00 00",
      notes: NOTES,
      archivedAt: o.archived ? new Date() : null,
      createdBy: AUDITOR,
      updatedBy: AUDITOR,
    },
  });

const cleanup = async () => {
  await db.contact.deleteMany({ where: { createdBy: AUDITOR } });
  await db.company.deleteMany({ where: { name: { startsWith: PREFIX } } });
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
  });
  app = new Hono();
  app.route("/", createSystemContactsRouter(createSystemAuthMiddleware({ scope: SCOPE, jwks, audience: SERVICE_AUD })));
  noAudienceApp = new Hono();
  noAudienceApp.route(
    "/",
    createSystemContactsRouter(createSystemAuthMiddleware({ scope: SCOPE, jwks, audience: undefined })),
  );
  await cleanup();
  companyId = (await makeCompany("Acme")).id;
  otherCompanyId = (await makeCompany("Other")).id;
});

afterAll(cleanup);

describe("GET /system/contacts?companyId= — the referent picker's list (AC-3.6)", () => {
  it("lists that company's non-archived contacts by last then first name, with only id, names and job title", async () => {
    const own = await makeCompany("Own");
    const zed = await makeContact({ companyId: own.id, firstName: "Anna", lastName: "Zed", jobTitle: "CTO" });
    const bravoC = await makeContact({ companyId: own.id, firstName: "Carla", lastName: "Bravo", jobTitle: null });
    const bravoA = await makeContact({ companyId: own.id, firstName: "Alma", lastName: "Bravo" });
    await makeContact({ companyId: own.id, lastName: "Archived", archived: true });
    await makeContact({ companyId: otherCompanyId, lastName: "Elsewhere" });
    await makeContact({ companyId: null, lastName: "Companyless" });

    const res = await get(`?companyId=${own.id}`, await serviceJwt());

    expect(res.status).toBe(200);
    const got = (await res.json()) as { items: CompanyItem[]; truncated: boolean };
    expect(Object.keys(got).sort()).toEqual(["items", "truncated"]);
    expect(got.truncated).toBe(false);
    expect(got.items).toEqual([
      { id: bravoA.id, firstName: "Alma", lastName: "Bravo", jobTitle: "Synthetic referent" },
      { id: bravoC.id, firstName: "Carla", lastName: "Bravo", jobTitle: null },
      { id: zed.id, firstName: "Anna", lastName: "Zed", jobTitle: "CTO" },
    ]);
    for (const item of got.items) expect(Object.keys(item).sort()).toEqual(["firstName", "id", "jobTitle", "lastName"]);
  });

  it("carries no email, phone, notes, audit field, version, archived flag or company id — not anywhere in the body (M2, L3)", async () => {
    const own = await makeCompany("Minimal");
    await makeContact({ companyId: own.id });
    const text = await (await get(`?companyId=${own.id}`, await serviceJwt())).text();
    for (const leak of [`${PREFIX}@example.test`, "+00 000 000 00 00", NOTES, AUDITOR, "version", "archived", "companyId"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("a company with no contact, or an unknown one, is an empty list", async () => {
    const empty = await makeCompany("Empty");
    const token = await serviceJwt();
    for (const id of [empty.id, "no-such-company"]) {
      const res = await get(`?companyId=${id}`, token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [], truncated: false });
    }
  });

  it("caps the list at 500 and says so with `truncated` (L8): exactly 500 is not truncated, 501 is", async () => {
    expect(CONTACTS_LIMIT).toBe(500);
    const big = await makeCompany("Big");
    await db.contact.createMany({
      data: Array.from({ length: CONTACTS_LIMIT }, (_, i) => ({
        companyId: big.id,
        firstName: "Bulk",
        lastName: `Row ${String(i).padStart(4, "0")}`,
        createdBy: AUDITOR,
        updatedBy: AUDITOR,
      })),
    });
    const token = await serviceJwt();
    const exact = (await (await get(`?companyId=${big.id}`, token)).json()) as { items: CompanyItem[]; truncated: boolean };
    expect(exact.items).toHaveLength(CONTACTS_LIMIT);
    expect(exact.truncated).toBe(false);

    await makeContact({ companyId: big.id, firstName: "Bulk", lastName: "Row 9999" });
    const over = (await (await get(`?companyId=${big.id}`, token)).json()) as { items: CompanyItem[]; truncated: boolean };
    expect(over.items).toHaveLength(CONTACTS_LIMIT);
    expect(over.truncated).toBe(true);
    // The cap keeps the head of the sort order: the 501st by last name is the one dropped.
    expect(over.items.map((i) => i.lastName)).not.toContain("Row 9999");
  });
});

describe("GET /system/contacts?ids= — a purchase order's referent, live (AC-3.8, AC-3.9)", () => {
  const idsOf = async (query: string) => {
    const res = await get(query, await serviceJwt());
    return { res, got: (await res.json()) as { items: ContactRow[] } };
  };

  it("returns those contacts with id, company, names, job title, email, phone and `archived` — nothing else — in the order asked", async () => {
    const first = await makeContact({ firstName: "Anna", lastName: "Zed", jobTitle: "CTO" });
    const second = await makeContact({ companyId: otherCompanyId, firstName: "Alma", lastName: "Bravo", jobTitle: null });
    const loose = await makeContact({ companyId: null, firstName: "Loose", lastName: "End" });

    const { res, got } = await idsOf(`?ids=${second.id},${loose.id},${first.id}`);

    expect(res.status).toBe(200);
    expect(Object.keys(got)).toEqual(["items"]);
    expect(got.items).toEqual([
      {
        id: second.id,
        companyId: otherCompanyId,
        firstName: "Alma",
        lastName: "Bravo",
        jobTitle: null,
        email: `${PREFIX}@example.test`,
        phone: "+00 000 000 00 00",
        archived: false,
      },
      {
        id: loose.id,
        companyId: null,
        firstName: "Loose",
        lastName: "End",
        jobTitle: "Synthetic referent",
        email: `${PREFIX}@example.test`,
        phone: "+00 000 000 00 00",
        archived: false,
      },
      {
        id: first.id,
        companyId,
        firstName: "Anna",
        lastName: "Zed",
        jobTitle: "CTO",
        email: `${PREFIX}@example.test`,
        phone: "+00 000 000 00 00",
        archived: false,
      },
    ]);
    for (const item of got.items) {
      expect(Object.keys(item).sort()).toEqual([
        "archived",
        "companyId",
        "email",
        "firstName",
        "id",
        "jobTitle",
        "lastName",
        "phone",
      ]);
    }
  });

  it("carries no notes, audit field or version — not anywhere in the body (L3)", async () => {
    const contact = await makeContact();
    const text = await (await get(`?ids=${contact.id}`, await serviceJwt())).text();
    for (const leak of [NOTES, AUDITOR, "version", "createdAt", "updatedAt"]) expect(text).not.toContain(leak);
  });

  it("an archived contact is still returned, flagged `archived: true`", async () => {
    const archived = await makeContact({ archived: true });
    const live = await makeContact();
    const { got } = await idsOf(`?ids=${archived.id},${live.id}`);
    expect(got.items.map((i) => [i.id, i.archived])).toEqual([
      [archived.id, true],
      [live.id, false],
    ]);
  });

  it("an erased contact is absent, as is an unknown id, and a repeated id comes back once", async () => {
    const erased = await makeContact();
    const kept = await makeContact();
    await db.contact.delete({ where: { id: erased.id } });

    const { res, got } = await idsOf(`?ids=${erased.id},no-such-contact,${kept.id},${kept.id}`);

    expect(res.status).toBe(200);
    expect(got.items.map((i) => i.id)).toEqual([kept.id]);
  });
});

describe("GET /system/contacts — exactly one of companyId and ids, well formed (400)", () => {
  it("neither, both, or an unrelated parameter alone is a 400 problem naming the query", async () => {
    const token = await serviceJwt();
    for (const query of ["", "?companyId=a&ids=b", "?q=x", "?stage=won"]) {
      const res = await get(query, token);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
      expect(await res.json()).toMatchObject({ status: 400, instance: URL_PATH });
    }
  });

  it("an empty or over-long companyId, or a repeated companyId, is a 400; 64 characters is accepted", async () => {
    const token = await serviceJwt();
    for (const query of ["?companyId=", `?companyId=${"x".repeat(65)}`, "?companyId=a&companyId=b"]) {
      expect({ query, status: (await get(query, token)).status }).toEqual({ query, status: 400 });
    }
    expect((await get(`?companyId=${"x".repeat(64)}`, token)).status).toBe(200);
  });

  it("an empty entry, an empty list or an id longer than 64 characters is a 400; 64 characters is accepted", async () => {
    const token = await serviceJwt();
    for (const query of ["?ids=a,,b", "?ids=", "?ids=a,", "?ids=%20", `?ids=${"x".repeat(65)}`, "?ids=a&ids=b"]) {
      expect({ query, status: (await get(query, token)).status }).toEqual({ query, status: 400 });
    }
    expect((await get(`?ids=${"x".repeat(64)}`, token)).status).toBe(200);
  });

  it("more than 20 ids is a 400; exactly 20 is accepted", async () => {
    expect(MAX_CONTACT_IDS).toBe(20);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(",");
    const token = await serviceJwt();
    expect((await get(`?ids=${ids(21)}`, token)).status).toBe(400);
    expect((await get(`?ids=${ids(20)}`, token)).status).toBe(200);
  });

  it("a mode never leaks into the other: `ids` returns no `truncated`, `companyId` no email", async () => {
    const own = await makeCompany("Modes");
    const contact = await makeContact({ companyId: own.id });
    const token = await serviceJwt();
    expect(Object.keys((await (await get(`?ids=${contact.id}`, token)).json()) as object)).toEqual(["items"]);
    const byCompany = (await (await get(`?companyId=${own.id}`, token)).json()) as { items: object[] };
    expect(byCompany.items).toHaveLength(1);
    expect("email" in byCompany.items[0]!).toBe(false);
  });
});

describe("GET /system/contacts — the credential (every failure is the same 401)", () => {
  it("no token, a user JWT, another scope, another audience, a non-service sub, expired, malformed: one identical body", async () => {
    const userJwt = await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE, scope: null });
    const q = "?companyId=any";
    const failures: Array<[string, Response]> = [
      ["no token", await get(q)],
      ["a user JWT", await get(q, userJwt)],
      ["a user JWT with the scope claim", await get(q, await serviceJwt({ sub: "user-1", aud: TEST_AUDIENCE }))],
      ["another scope (deals)", await get(q, await serviceJwt({ scope: "crm.deals.read" }))],
      ["another scope (companies)", await get(q, await serviceJwt({ scope: "crm.companies.read" }))],
      ["no scope claim", await get(q, await serviceJwt({ scope: null }))],
      ["a scope that only contains ours", await get(q, await serviceJwt({ scope: `${SCOPE}.extra` }))],
      ["another audience", await get(q, await serviceJwt({ aud: "someone-else" }))],
      ["a sub that is not a service principal", await get(q, await serviceJwt({ sub: "projects-api" }))],
      ["an empty service sub", await get(q, await serviceJwt({ sub: "system:" }))],
      ["an expired token", await get(q, await serviceJwt({ exp: Math.floor(Date.now() / 1000) - 60 }))],
      ["a malformed token", await get(q, "not-a-jwt")],
    ];
    const reference = await failures[0]![1].clone().text();
    expect(JSON.parse(reference)).toMatchObject({ status: 401, instance: URL_PATH });
    for (const [label, res] of failures) {
      expect({ label, status: res.status }).toEqual({ label, status: 401 });
      expect({ label, body: await res.text() }).toEqual({ label, body: reference });
    }
  });

  it("the credential is checked before the query: a bad token with a bad query is the 401, not a 400", async () => {
    expect((await get("")).status).toBe(401);
    expect((await get("?companyId=a&ids=b", "not-a-jwt")).status).toBe(401);
  });

  it("a token carrying our scope among others is accepted, and so is each mode", async () => {
    const token = await serviceJwt({ scope: `crm.deals.read ${SCOPE}` });
    expect((await get("?companyId=any", token)).status).toBe(200);
    expect((await get("?ids=any", token)).status).toBe(200);
  });

  it("fails closed when SERVICE_AUDIENCE is not configured, even for an otherwise valid token", async () => {
    expect((await get("?companyId=any", await serviceJwt(), noAudienceApp)).status).toBe(401);
  });
});

describe("GET /system/contacts — mounted on the assembled app", () => {
  it("a user JWT is never accepted here, and no token is the same 401 (not a 404)", async () => {
    const { app: assembled, call } = await import("../test-support/world");
    expect(assembled.routes.some((r) => r.method === "GET" && r.path === URL_PATH)).toBe(true);
    expect((await call("GET", `${URL_PATH}?companyId=any`, { as: null })).status).toBe(401);
    expect((await call("GET", `${URL_PATH}?ids=any`, { as: "admin" })).status).toBe(401);
  });

  it("is documented in the OpenAPI document", async () => {
    const { app: assembled } = await import("../test-support/world");
    const doc = (await (await assembled.request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain(URL_PATH);
  });
});
