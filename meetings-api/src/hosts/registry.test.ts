import { afterAll, describe, expect, it } from "bun:test";
import { buildRegistry, publicView, type HostDefinition } from "./registry";
import { startFakeHost } from "../test-support/fakeHost";

const fake = startFakeHost();
afterAll(() => fake.stop());

const crm = "http://crm-api.railway.internal:8084";

describe("production registry (AC-11.1)", () => {
  const registry = buildRegistry({ production: true, crmApiUrl: crm });

  it("contains exactly crm/deal", () => {
    expect(registry.all().map((h) => `${h.app}/${h.entityType}`)).toEqual(["crm/deal"]);
  });

  it("describes the CRM as the plan does", () => {
    expect(registry.get("crm", "deal")).toEqual({
      app: "crm",
      entityType: "deal",
      baseUrl: crm,
      labels: {
        en: {
          app: "CRM",
          entity: "Deal",
          visibilityHint: "and can see deal financials",
          noticeFailed: "The deal's activity could not be added",
        },
        it: {
          app: "CRM",
          entity: "Opportunità",
          visibilityHint: "e possono vedere i dati economici dell'opportunità",
          noticeFailed: "Non è stato possibile aggiungere l'attività all'opportunità",
        },
      },
      offersHostVisible: true,
      hostVisibleRequirement: "deal:financials",
      notices: true,
      recommendedTemplates: ["builtin:sales-discovery"],
      contract: 1,
    });
  });

  it("returns undefined for a host that is not registered", () => {
    expect(registry.get("crm", "company")).toBeUndefined();
    expect(registry.get("pm", "project")).toBeUndefined();
  });

  it("ignores test hosts even if some were passed (defence in depth)", () => {
    const withTest = buildRegistry({ production: true, crmApiUrl: crm, testHosts: fake.definitions });
    expect(withTest.all().map((h) => h.app)).toEqual(["crm"]);
  });

  it("has labels in both languages for every entry", () => {
    for (const host of registry.all()) {
      for (const lang of ["en", "it"] as const) {
        for (const text of Object.values(host.labels[lang])) expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("outside production", () => {
  it("adds the test hosts after the CRM", () => {
    const registry = buildRegistry({ production: false, crmApiUrl: crm, testHosts: fake.definitions });
    expect(registry.all().map((h) => `${h.app}/${h.entityType}`)).toEqual(["crm/deal", "testhost/widget", "quiethost/gadget"]);
    expect(registry.get("testhost", "widget")?.notices).toBe(true);
    expect(registry.get("quiethost", "gadget")?.notices).toBe(false);
    expect(registry.get("quiethost", "gadget")?.offersHostVisible).toBe(false);
  });

  it("refuses a malformed test host, naming the member and not the value", () => {
    const bad = { ...fake.definitions[0]!, baseUrl: "super-secret-not-a-url" } as unknown as HostDefinition;
    expect(() => buildRegistry({ production: false, crmApiUrl: crm, testHosts: [bad] })).toThrow(/baseUrl/);
    try {
      buildRegistry({ production: false, crmApiUrl: crm, testHosts: [bad] });
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret");
    }
  });

  it("refuses a test host with an unknown member (strict)", () => {
    const extra = { ...fake.definitions[0]!, sneaky: true };
    expect(() => buildRegistry({ production: false, crmApiUrl: crm, testHosts: [extra] })).toThrow();
  });

  it("refuses two hosts with the same app and entity type, the CRM included", () => {
    const clash = { ...fake.definitions[0]!, app: "crm", entityType: "deal" };
    expect(() => buildRegistry({ production: false, crmApiUrl: crm, testHosts: [clash] })).toThrow();
    expect(() => buildRegistry({ production: false, crmApiUrl: crm, testHosts: [fake.definitions[0], fake.definitions[0]] })).toThrow();
  });
});

describe("publicView (what GET /hosts serves)", () => {
  it("carries labels incl. visibilityHint and noticeFailed, the host-visible offer and the recommended templates", () => {
    const view = publicView(buildRegistry({ production: true, crmApiUrl: crm }).get("crm", "deal")!);
    expect(Object.keys(view).sort()).toEqual(["app", "entityType", "labels", "offersHostVisible", "recommendedTemplates"]);
    expect(view.labels.it.visibilityHint).toContain("opportunità");
    expect(view.labels.en.noticeFailed).toContain("could not be added");
  });

  it("never reveals the host's internal base URL", () => {
    expect(JSON.stringify(publicView(buildRegistry({ production: true, crmApiUrl: crm }).get("crm", "deal")!))).not.toContain("railway.internal");
  });
});
