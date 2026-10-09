/**
 * Unit tests for `SERVICE_CLIENTS` parsing and client authentication (T4,
 * specs/015-hardware-inventory — ADR-0044). Pure: no DB, no env, no network.
 */

import { describe, expect, test } from "bun:test";
import {
  authenticateServiceClient,
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

  test("the scope allowlist is exactly notifications.push", () => {
    expect([...KNOWN_SERVICE_SCOPES]).toEqual(["notifications.push"]);
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
