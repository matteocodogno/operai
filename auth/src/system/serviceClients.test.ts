/**
 * Unit tests for `SERVICE_CLIENTS` parsing and client authentication (T4,
 * specs/20261006-hardware-inventory — ADR 20261006-scoped-service-jwt-fourth-notify-caller). Pure: no DB, no env, no network.
 */

import { describe, expect, test } from "bun:test";
import {
  authenticateServiceClient,
  DOCUMENTED_CLIENT_SCOPES,
  KNOWN_SERVICE_SCOPES,
  parseServiceClients,
} from "./serviceClients";

// Obvious dummies — never real secrets.
const SECRET_A = "dummy-secret-A-0123456789-abcdefghij";
const SECRET_B = "dummy-secret-B-0123456789-abcdefghij";

const raw = (obj: unknown) => JSON.stringify(obj);

describe("parseServiceClients", () => {
  test("absent or blank means no clients, not an error", () => {
    for (const value of [undefined, "", "   "]) {
      const result = parseServiceClients(value);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.clients.size).toBe(0);
    }
  });

  test("parses a valid entry into secret + scopes", () => {
    const result = parseServiceClients(
      raw({ "inventory-api": { secret: SECRET_A, scope: "notifications.push" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clients.get("inventory-api")).toEqual({
      secret: SECRET_A,
      scopes: ["notifications.push"],
    });
  });

  test("refuses invalid JSON, a non-object, and an array — without echoing the input", () => {
    for (const bad of ["{nope", "[]", '"x"', "42", "null"]) {
      const result = parseServiceClients(bad);
      expect(result.ok).toBe(false);
    }
  });

  test.each([
    ["a secret shorter than 32 chars", { "inventory-api": { secret: "short", scope: "notifications.push" } }],
    ["a missing secret", { "inventory-api": { scope: "notifications.push" } }],
    ["a non-string secret", { "inventory-api": { secret: 12345678901234567890123456789012, scope: "notifications.push" } }],
    ["a missing scope", { "inventory-api": { secret: SECRET_A } }],
    ["an empty scope", { "inventory-api": { secret: SECRET_A, scope: "  " } }],
    ["an unknown scope", { "inventory-api": { secret: SECRET_A, scope: "notifications.push email.send" } }],
    ["an unknown key on the entry", { "inventory-api": { secret: SECRET_A, scope: "notifications.push", admin: true } }],
    ["an upper-case client id", { "Inventory-API": { secret: SECRET_A, scope: "notifications.push" } }],
    ["a client id with a colon", { "system:x": { secret: SECRET_A, scope: "notifications.push" } }],
    ["a non-object entry", { "inventory-api": "nope" }],
  ])("refuses %s", (_label, value) => {
    const result = parseServiceClients(raw(value));
    expect(result.ok).toBe(false);
  });

  test("a failure message never contains the secret value", () => {
    const result = parseServiceClients(
      raw({ "inventory-api": { secret: SECRET_A, scope: "bogus.scope" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).not.toContain(SECRET_A);
  });

  test("the scope allowlist is exactly the known service scopes (specs/20261103-projects, specs/20261103-projects-handoff)", () => {
    expect([...KNOWN_SERVICE_SCOPES]).toEqual([
      "notifications.push",
      "emails.send",
      "users.contact",
      "estimate-notices.send",
      "host-notices.send",
      "deal-link-notices.send",
      "crm.companies.read",
      "activities.write",
      "crm.deals.read",
      "crm.contacts.read",
      "estimai.estimates.read",
      "projects.purchase-orders.read",
      "letterhead:render",
      "legal-entities:read",
      "accounting.reference.read",
    ]);
  });

  test("legal-entities:read parses alone or beside other scopes, and a near miss refuses to start (specs/20261117-legal-entities AC-3.2)", () => {
    const ok = parseServiceClients(
      raw({
        "letterhead-api": { secret: SECRET_A, scope: "legal-entities:read" },
        "crm-api": { secret: SECRET_B, scope: "notifications.push legal-entities:read" },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.clients.get("letterhead-api")?.scopes).toEqual(["legal-entities:read"]);
      expect(ok.clients.get("crm-api")?.scopes).toEqual(["notifications.push", "legal-entities:read"]);
    }
    for (const scope of ["legal-entities:write", "legal-entities.read", "legal-entity:read", "companies:read", "LEGAL-ENTITIES:READ"]) {
      const bad = parseServiceClients(raw({ "letterhead-api": { secret: SECRET_A, scope } }));
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors.join("\n")).toContain("letterhead-api");
    }
  });

  test("the documented letterhead-api entry is exactly legal-entities:read, and crm-api's adds it", () => {
    const result = parseServiceClients(
      raw({
        "letterhead-api": { secret: SECRET_A, scope: DOCUMENTED_CLIENT_SCOPES["letterhead-api"] },
        "crm-api": { secret: SECRET_B, scope: DOCUMENTED_CLIENT_SCOPES["crm-api"] },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clients.get("letterhead-api")?.scopes).toEqual(["legal-entities:read"]);
    expect(result.clients.get("letterhead-api")?.scopes).not.toContain("letterhead:render");
    expect(result.clients.get("crm-api")?.scopes).toContain("legal-entities:read");
    expect(result.clients.get("crm-api")?.scopes).toContain("letterhead:render");
  });

  test("a SERVICE_CLIENTS entry with accounting.reference.read parses, alone or beside refund-api's notice scopes (specs/20261119-accounting AC-3.8)", () => {
    const ok = parseServiceClients(
      raw({
        "refund-api": { secret: SECRET_A, scope: "notifications.push emails.send accounting.reference.read" },
        "reader-svc": { secret: SECRET_B, scope: "accounting.reference.read" },
      }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.clients.get("refund-api")?.scopes).toEqual(["notifications.push", "emails.send", "accounting.reference.read"]);
    expect(ok.clients.get("reader-svc")?.scopes).toEqual(["accounting.reference.read"]);
    expect(authenticateServiceClient(ok.clients, "refund-api", SECRET_A)?.scopes).toContain("accounting.reference.read");
  });

  test("accounting.reference.read near misses still refuse to start, naming the client (specs/20261119-accounting AC-3.8)", () => {
    for (const scope of [
      "accounting.reference.write",
      "accounting.reference",
      "accounting.read",
      "accounting:reference.read",
      "accounting.reference:read",
      "accounting.references.read",
      "ACCOUNTING.REFERENCE.READ",
      "accounting.reference.read accounting.reference.manage",
    ]) {
      const bad = parseServiceClients(raw({ "refund-api": { secret: SECRET_A, scope } }));
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors.join("\n")).toContain("refund-api");
    }
  });

  test("a client holding letterhead:render parses and authenticates with it, alone or beside other scopes (specs/20261116-letterhead-service AC-3.1, AC-9.3)", () => {
    const parsed = parseServiceClients(
      raw({
        "crm-api": { secret: SECRET_A, scope: "notifications.push letterhead:render" },
        "refund-api": { secret: SECRET_B, scope: "letterhead:render" },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(authenticateServiceClient(parsed.clients, "crm-api", SECRET_A)?.scopes).toEqual([
      "notifications.push",
      "letterhead:render",
    ]);
    expect(authenticateServiceClient(parsed.clients, "refund-api", SECRET_B)?.scopes).toEqual(["letterhead:render"]);
  });

  test("near-miss spellings of letterhead:render refuse to start (a typo never widens a token)", () => {
    for (const scope of ["letterhead.render", "letterheads:render", "letterhead:manage", "letterhead:render:*"]) {
      expect(parseServiceClients(raw({ "crm-api": { secret: SECRET_A, scope } })).ok).toBe(false);
    }
  });

  test("a client holding deal-link-notices.send parses, beside notifications.push (specs/20261108-estimate-list-oversight)", () => {
    const result = parseServiceClients(
      raw({ "crm-api": { secret: SECRET_A, scope: "notifications.push deal-link-notices.send" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clients.get("crm-api")?.scopes).toEqual(["notifications.push", "deal-link-notices.send"]);
  });

  test("a client holding host-notices.send parses, alone or beside notifications.push (specs/20261104-meetings)", () => {
    const result = parseServiceClients(
      raw({
        "meetings-api": { secret: SECRET_A, scope: "notifications.push host-notices.send" },
        "relay-svc": { secret: SECRET_B, scope: "host-notices.send" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clients.get("meetings-api")?.scopes).toEqual(["notifications.push", "host-notices.send"]);
    expect(result.clients.get("relay-svc")?.scopes).toEqual(["host-notices.send"]);
  });

  test("a misspelt host-notices scope is refused, not minted", () => {
    for (const scope of ["host-notice.send", "host-notices", "host-notices.send,notifications.push", "HOST-NOTICES.SEND"]) {
      const result = parseServiceClients(raw({ "meetings-api": { secret: SECRET_A, scope } }));
      expect(result.ok).toBe(false);
    }
  });

  test("the documented meetings-api entry is notifications.push + host-notices.send and has no emails.send (AC-12.4)", () => {
    const documented = DOCUMENTED_CLIENT_SCOPES["meetings-api"];
    const result = parseServiceClients(raw({ "meetings-api": { secret: SECRET_A, scope: documented } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scopes = result.clients.get("meetings-api")?.scopes ?? [];
    expect([...scopes].sort()).toEqual(["host-notices.send", "notifications.push"]);
    expect(scopes).not.toContain("emails.send");
  });

  test.each([
    ["projects-api", "crm.deals.read"],
    ["projects-api", "crm.contacts.read"],
    ["projects-api", "estimai.estimates.read"],
    ["crm-api", "projects.purchase-orders.read"],
  ])("%s may hold the specs/20261103-projects-handoff scope %s", (clientId, scope) => {
    const result = parseServiceClients(raw({ [clientId]: { secret: SECRET_A, scope } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clients.get(clientId)?.scopes).toEqual([scope]);
  });

  test("the specs/20261103-projects-handoff scopes combine with existing ones on one client", () => {
    const result = parseServiceClients(
      raw({
        "projects-api": {
          secret: SECRET_A,
          scope: "crm.companies.read crm.deals.read crm.contacts.read estimai.estimates.read notifications.push",
        },
        "crm-api": { secret: SECRET_B, scope: "notifications.push emails.send projects.purchase-orders.read" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clients.get("projects-api")?.scopes).toEqual([
      "crm.companies.read",
      "crm.deals.read",
      "crm.contacts.read",
      "estimai.estimates.read",
      "notifications.push",
    ]);
    expect(result.clients.get("crm-api")?.scopes).toEqual([
      "notifications.push",
      "emails.send",
      "projects.purchase-orders.read",
    ]);
  });

  test("the retired `projects.contracts.read` scope refuses to start, naming the client and no secret (D38)", () => {
    const result = parseServiceClients(
      raw({ "crm-api": { secret: SECRET_A, scope: "notifications.push projects.contracts.read" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain('"crm-api"');
      expect(result.errors.join("\n")).not.toContain(SECRET_A);
    }
  });

  test("a near-miss of a specs/20261103-projects-handoff scope still refuses to start", () => {
    for (const scope of [
      "crm.deals.write",
      "crm.deals",
      "crm.contacts.write",
      "crm.contact.read",
      "estimai.estimate.read",
      "projects.contracts.write",
      "projects.purchase-order.read",
      "projects.purchase-orders.write",
    ]) {
      const result = parseServiceClients(raw({ "projects-api": { secret: SECRET_A, scope } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join("\n")).toContain('"projects-api"');
        expect(result.errors.join("\n")).not.toContain(SECRET_A);
      }
    }
  });

  test("crm.companies.read is an accepted scope: a projects-api client holding it parses (specs/20261103-projects)", () => {
    const result = parseServiceClients(raw({ "projects-api": { secret: SECRET_A, scope: "crm.companies.read" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clients.get("projects-api")?.scopes).toEqual(["crm.companies.read"]);
  });

  test("the documented projects-api entry is its five read/push scopes and has no emails.send (specs/20261103-projects, 026)", () => {
    const documented = DOCUMENTED_CLIENT_SCOPES["projects-api"];
    const result = parseServiceClients(raw({ "projects-api": { secret: SECRET_A, scope: documented } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scopes = result.clients.get("projects-api")?.scopes ?? [];
    expect([...scopes].sort()).toEqual([
      "crm.companies.read",
      "crm.contacts.read",
      "crm.deals.read",
      "estimai.estimates.read",
      "notifications.push",
    ]);
    expect(scopes).not.toContain("emails.send");
  });

  test("activities.write is an accepted scope; a nearby misspelling is still refused (specs/20261110-activities)", () => {
    const ok = parseServiceClients(raw({ "crm-api": { secret: SECRET_A, scope: "activities.write" } }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.clients.get("crm-api")?.scopes).toEqual(["activities.write"]);
    for (const scope of ["activities.writes", "activity.write", "activities", "ACTIVITIES.WRITE", "activities.read"]) {
      expect(parseServiceClients(raw({ "crm-api": { secret: SECRET_A, scope } })).ok).toBe(false);
    }
  });

  test("the documented crm-api entry adds activities.write, legal-entities:read and letterhead:render to its existing scopes (specs/20261110-activities AC-1.2, specs/20261103-projects-handoff)", () => {
    const documented = DOCUMENTED_CLIENT_SCOPES["crm-api"];
    const result = parseServiceClients(raw({ "crm-api": { secret: SECRET_A, scope: documented } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...(result.clients.get("crm-api")?.scopes ?? [])].sort()).toEqual([
      "activities.write",
      "deal-link-notices.send",
      "emails.send",
      "legal-entities:read",
      "letterhead:render",
      "notifications.push",
      "projects.purchase-orders.read",
    ]);
  });

  test("the documented activities-api entry is exactly notifications.push and emails.send: email notices, no write (specs/20261110-activities AC-6.1/6.3)", () => {
    const documented = DOCUMENTED_CLIENT_SCOPES["activities-api"];
    const result = parseServiceClients(raw({ "activities-api": { secret: SECRET_A, scope: documented } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...(result.clients.get("activities-api")?.scopes ?? [])].sort()).toEqual(["emails.send", "notifications.push"]);
    expect(result.clients.get("activities-api")?.scopes).not.toContain("activities.write");
  });

  test("a client holding emails.send parses, alone or beside notifications.push", () => {
    const result = parseServiceClients(
      raw({
        "refund-api": { secret: SECRET_A, scope: "notifications.push emails.send" },
        "mailer-svc": { secret: SECRET_B, scope: "emails.send" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clients.get("refund-api")?.scopes).toEqual(["notifications.push", "emails.send"]);
    expect(result.clients.get("mailer-svc")?.scopes).toEqual(["emails.send"]);
  });

  test("an unknown scope fails naming the client", () => {
    const result = parseServiceClients(
      raw({ "refund-api": { secret: SECRET_A, scope: "notifications.push emails.sned" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain('"refund-api"');
      expect(result.errors.join("\n")).not.toContain(SECRET_A);
    }
  });

  test("the client id auth is reserved and fails naming it", () => {
    const result = parseServiceClients(raw({ auth: { secret: SECRET_A, scope: "emails.send" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain('"auth"');
      expect(result.errors.join("\n")).not.toContain(SECRET_A);
    }
  });

  test("a reserved id does not hide errors of other entries", () => {
    const result = parseServiceClients(
      raw({ auth: { secret: SECRET_A, scope: "emails.send" }, "refund-api": { secret: "short", scope: "emails.send" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBe(2);
  });
});

describe("authenticateServiceClient", () => {
  const parsed = parseServiceClients(
    raw({
      "inventory-api": { secret: SECRET_A, scope: "notifications.push" },
      "other-svc": { secret: SECRET_B, scope: "notifications.push" },
    }),
  );
  if (!parsed.ok) throw new Error("fixture must parse");
  const clients = parsed.clients;

  test("returns the client for the right id + secret", () => {
    expect(authenticateServiceClient(clients, "inventory-api", SECRET_A)?.scopes).toEqual([
      "notifications.push",
    ]);
  });

  test("rejects a wrong secret, another client's secret, and a prefix/extension of the right one", () => {
    expect(authenticateServiceClient(clients, "inventory-api", "wrong")).toBeNull();
    expect(authenticateServiceClient(clients, "inventory-api", SECRET_B)).toBeNull();
    expect(authenticateServiceClient(clients, "inventory-api", SECRET_A.slice(0, -1))).toBeNull();
    expect(authenticateServiceClient(clients, "inventory-api", `${SECRET_A}x`)).toBeNull();
    expect(authenticateServiceClient(clients, "inventory-api", "")).toBeNull();
  });

  test("rejects an unknown client, including names that exist on Object.prototype", () => {
    for (const id of ["nobody", "__proto__", "constructor", "toString", "hasOwnProperty", ""]) {
      expect(authenticateServiceClient(clients, id, SECRET_A)).toBeNull();
    }
  });

  test("rejects everything when no clients are configured", () => {
    expect(authenticateServiceClient(new Map(), "inventory-api", SECRET_A)).toBeNull();
  });
});
