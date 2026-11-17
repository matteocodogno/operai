import { beforeEach, describe, expect, it } from "bun:test";
import { call, makeCompany, resetWorld } from "../test-support/world";
import { requiredText, optionalText } from "./http";

/**
 * Security round 6, L-8 (specs/20261115-crm-offer-wizard): Postgres text cannot hold U+0000, so a NUL in free text that
 * reached an insert was a driver error, a 500 and a raw message in the log. `hasNoNul` is the one mechanism for every
 * string a route hands to Prisma; `requiredText` and `optionalText` now apply it, so every field built from them (the
 * entity profile's name, place of issue and terms, a company's name, a contact's names) answers 422 naming the field.
 */

const NUL = "bad\u0000text";

const refusedNaming = (res: { status: number; json: any }, field: string) => {
  expect(res.status).toBe(422);
  expect(res.json.field).toBe(field);
  // the body never echoes the value, in any spelling of the character
  const body = JSON.stringify(res.json);
  expect(body).not.toContain("\u0000");
  expect(body).not.toContain("\\u0000");
  expect(body).not.toContain("badtext");
  expect(body).not.toContain("bad");
};

describe("a NUL in an entity profile's free text is a 422 naming the field, never a 500", () => {
  beforeEach(resetWorld);
  const put = (patch: Record<string, unknown>) => call("PUT", "/entity-profiles/welld_ch", { as: "admin", body: patch });

  it("placeOfIssue and the optional terms", async () => {
    refusedNaming(await put({ placeOfIssue: NUL }), "placeOfIssue");
    refusedNaming(await put({ offerTermsEn: NUL }), "offerTermsEn");
    refusedNaming(await put({ offerTermsIt: NUL }), "offerTermsIt");
  });

  it("nothing is written for a refused body, and a clean one is still saved", async () => {
    await put({ offerTermsEn: NUL });
    const stored = (await call("GET", "/entity-profiles")).json.items as { offerTermsEn: string | null }[];
    expect(stored.some((p) => p.offerTermsEn?.includes("\u0000"))).toBe(false);
    const ok = await put({ placeOfIssue: "Zug" });
    expect(ok.status).toBe(200);
    expect(ok.json.placeOfIssue).toBe("Zug");
  });

  it("a NUL only after the trim is still a NUL (whitespace around it does not hide it)", async () => {
    refusedNaming(await put({ placeOfIssue: "  \u0000  " }), "placeOfIssue");
  });

  it("a NUL in a legacy legal key is accepted and ignored: nothing of it is stored, so no insert can fail (AC-6.1)", async () => {
    const res = await put({ legalName: NUL, addressLines: [NUL], vatNumber: NUL, iban: NUL, placeOfIssue: "Zug" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toContain("bad");
  });
});

describe("the same for the CRM's own entities", () => {
  beforeEach(resetWorld);

  it("a company's name, on create and on update", async () => {
    const create = await call("POST", "/companies", { as: "admin", body: { name: NUL, status: "prospect", entity: "welld_ch" } });
    refusedNaming(create, "name");
    const company = await makeCompany();
    const update = await call("PATCH", `/companies/${company.id}`, { as: "admin", ifMatch: company.version, body: { name: NUL } });
    refusedNaming(update, "name");
  });

  it("a company's optional text and a contact's names", async () => {
    refusedNaming(await call("POST", "/companies", { as: "admin", body: { name: "Acme", status: "prospect", entity: "welld_ch", city: NUL } }), "city");
    const company = await makeCompany();
    const contact = await call("POST", "/contacts", { as: "admin", body: { companyId: company.id, firstName: NUL, lastName: "Rossi" } });
    refusedNaming(contact, "firstName");
  });
});

describe("the schemas themselves", () => {
  it("requiredText and optionalText refuse a NUL and keep their trimming", () => {
    expect(requiredText(10).safeParse("a\u0000b").success).toBe(false);
    expect(optionalText(10).safeParse("a\u0000b").success).toBe(false);
    expect(requiredText(10).parse("  ok ")).toBe("ok");
    expect(optionalText(10).parse("  ")).toBeNull();
    expect(optionalText(10).parse(null)).toBeNull();
    expect(optionalText(10).parse(undefined)).toBeUndefined();
  });
});
