/**
 * crm-api client for CRM contacts (specs/022 T24; AC-3.6, T18 M1, M3, L1, L3): the contacts of a
 * company for the referent picker, and the check that a referent id is a live contact of the right
 * company. Read as ITSELF (a service JWT with `crm.contacts.read`), live, never cached. The CRM is
 * the fake of test-support/world.ts; every contact is synthetic.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { CRM_CONTACT_IDS_LIMIT, crm, makeContact, resetWorld, SERVICE_JWT } from "../test-support/world";
import { assertValidReferent, companyContacts, contactsById, CrmUnavailableError } from "./crm";
import { ProblemError } from "./problem";

beforeEach(resetWorld);

/** The problem an `assertValidReferent` call throws, as a plain object. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string | undefined; detail: string; extras: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) return { status: error.status, code: error.code, detail: error.message, extras: error.extras };
    throw error;
  }
  throw new Error("expected the check to refuse");
}

describe("companyContacts() — the referent picker's list (AC-3.6, T18 M1)", () => {
  it("lists the company's non-archived contacts as { id, name, jobTitle }, by last then first name", async () => {
    crm.contacts = [
      makeContact({ id: "c-b", firstName: "Zed", lastName: "Baker", jobTitle: null }),
      makeContact({ id: "c-a", firstName: "Ann", lastName: "Archer", jobTitle: "CTO" }),
      makeContact({ id: "c-old", firstName: "Old", lastName: "Archer", archived: true }),
      makeContact({ id: "c-other", companyId: "co-zeta" }),
      makeContact({ id: "c-none", companyId: null }),
    ];
    expect(await companyContacts("co-acme")).toEqual({
      items: [
        { id: "c-a", name: "Ann Archer", jobTitle: "CTO" },
        { id: "c-b", name: "Zed Baker", jobTitle: null },
      ],
      truncated: false,
    });
  });

  it("carries no email, phone, company or archived flag", async () => {
    crm.contacts = [makeContact()];
    const { items } = await companyContacts("co-acme");
    expect(Object.keys(items[0]!).sort()).toEqual(["id", "jobTitle", "name"]);
  });

  it("reads as the service principal, in `companyId` mode, live every time", async () => {
    await companyContacts("co-acme");
    await companyContacts("co-acme");
    expect(crm.lastAuthorization).toBe(`Bearer ${SERVICE_JWT}`);
    expect(crm.lastContactsQuery).toBe("?companyId=co-acme");
    expect(crm.contactCalls).toBe(2);
  });

  it("throws CrmUnavailableError when crm-api is down", async () => {
    crm.down = true;
    await expect(companyContacts("co-acme")).rejects.toBeInstanceOf(CrmUnavailableError);
  });
});

describe("contactsById() — contacts asked for by id", () => {
  it("returns the contacts, archived ones included, keyed by id; an unknown id is absent", async () => {
    crm.contacts = [makeContact({ id: "c-1" }), makeContact({ id: "c-2", archived: true })];
    const found = await contactsById(["c-1", "c-2", "c-missing"]);
    expect([...found.keys()].sort()).toEqual(["c-1", "c-2"]);
    expect(found.get("c-2")).toMatchObject({ id: "c-2", companyId: "co-acme", archived: true });
  });

  it("asks in `ids` mode, as the service principal", async () => {
    await contactsById(["c-1", "c-2"]);
    expect(crm.lastContactsQuery).toBe("?ids=c-1%2Cc-2");
    expect(crm.lastAuthorization).toBe(`Bearer ${SERVICE_JWT}`);
  });

  it("splits a long list so no request carries more ids than crm-api takes", async () => {
    const all = Array.from({ length: CRM_CONTACT_IDS_LIMIT * 2 + 1 }, (_, i) => makeContact({ id: `c-${i}` }));
    crm.contacts = all;
    const found = await contactsById(all.map((contact) => contact.id));
    expect(found.size).toBe(all.length);
    expect(crm.contactCalls).toBe(3);
  });

  it("makes no request for no ids", async () => {
    expect((await contactsById([])).size).toBe(0);
    expect(crm.contactCalls).toBe(0);
  });

  it("throws CrmUnavailableError when crm-api is down", async () => {
    crm.down = true;
    await expect(contactsById(["c-1"])).rejects.toBeInstanceOf(CrmUnavailableError);
  });
});

describe("assertValidReferent() — a live contact of the deal's company (AC-3.6, T18 M3, L1)", () => {
  it("accepts a non-archived contact of the company", async () => {
    crm.contacts = [makeContact({ id: "c-1", companyId: "co-acme" })];
    await assertValidReferent("c-1", "co-acme");
  });

  it("refuses an unknown contact, a contact of another company and a contact with no company with ONE identical problem", async () => {
    crm.contacts = [makeContact({ id: "c-other", companyId: "co-zeta" }), makeContact({ id: "c-none", companyId: null })];
    const unknown = await refusal(assertValidReferent("c-missing", "co-acme"));
    const otherCompany = await refusal(assertValidReferent("c-other", "co-acme"));
    const noCompany = await refusal(assertValidReferent("c-none", "co-acme"));

    expect(unknown).toEqual({ status: 422, code: "referent_invalid", detail: expect.any(String), extras: {} });
    // Identical to the byte: nothing tells "does not exist" from "exists elsewhere" (T18 L1).
    expect(otherCompany).toEqual(unknown);
    expect(noCompany).toEqual(unknown);
  });

  it("never echoes the id, the name or the company in the refusal", async () => {
    crm.contacts = [makeContact({ id: "c-other-xyz", companyId: "co-zeta", firstName: "Hidden", lastName: "Person" })];
    const problem = await refusal(assertValidReferent("c-other-xyz", "co-acme"));
    expect(JSON.stringify(problem)).not.toMatch(/c-other-xyz|Hidden|Person|co-zeta|co-acme/);
  });

  it("refuses an archived contact of the right company", async () => {
    crm.contacts = [makeContact({ id: "c-old", companyId: "co-acme", archived: true })];
    const problem = await refusal(assertValidReferent("c-old", "co-acme"));
    expect(problem).toMatchObject({ status: 422, code: "referent_invalid" });
  });

  it.each(["a,b", "c 1", "c%2C1", "c/1", "ü", "c1\n", "x".repeat(65), ""])(
    "refuses the id %j on its charset, without asking the CRM (T18 L1)",
    async (id) => {
      const problem = await refusal(assertValidReferent(id, "co-acme"));
      expect(problem).toMatchObject({ status: 422, code: "referent_invalid" });
      expect(crm.contactCalls).toBe(0);
    },
  );

  it("is a 503 crm_unavailable, not a refusal, when crm-api is down", async () => {
    crm.down = true;
    expect(await refusal(assertValidReferent("c-1", "co-acme"))).toMatchObject({ status: 503, code: "crm_unavailable" });
  });
});
