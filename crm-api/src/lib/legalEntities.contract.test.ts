/**
 * Contract test of crm-api's registry client against the REAL auth (specs/20261117-legal-entities T25; AC-3.2, AC-1.5).
 *
 * Every other test of the client stubs `fetch`; this one does not. crm-api's real service-token provider and real
 * `createLegalEntityRegistry` call a running auth: `POST /system/service-token` for the credential, then
 * `GET /system/legal-entities[/{entity}]` with it.
 *
 * ── Environment ──────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   LEGAL_ENTITIES_CONTRACT_URL           Base URL of a running auth, e.g. `http://localhost:3001` (compose). UNSET: the whole
 *                                         file is SKIPPED with a message naming this variable, so a plain `bun test` stays green
 *                                         without the service.
 *   LEGAL_ENTITIES_REQUIRE_CONTRACT       `1`: an unset URL FAILS instead of skipping (CI / the compose gate).
 *   LEGAL_ENTITIES_CONTRACT_CLIENT_ID     The service client crm-api uses in that auth (`SERVICE_CLIENTS` entry `crm-api`, which
 *   LEGAL_ENTITIES_CONTRACT_CLIENT_SECRET holds the scope `legal-entities:read`) and its secret. Both are required with the URL.
 *   LEGAL_ENTITIES_CONTRACT_NOSCOPE_CLIENT_ID / _SECRET
 *                                         OPTIONAL: a service client of that auth WITHOUT `legal-entities:read` (e.g. `activities-api`).
 *                                         When set, a valid service token of the wrong scope is also shown to be refused.
 *
 *   The registry is only read: nothing here writes to auth. The values are whatever the registry holds (the test checks the
 *   shape, not the text), and no value, token or secret is printed.
 *
 * ── What it proves ───────────────────────────────────────────────────────────────────────────────────────────────────
 *   1. with a `legal-entities:read` token the client reads BOTH entities and the answer is the contract's (the client's parser
 *      is the same one the shared fixture goes through);
 *   2. the single-entity route answers the same body as the list's item;
 *   3. without a token, with a token that is not one, and (when configured) with a service token of the wrong scope: 401, the
 *      same frozen body, and the client of such a credential fails closed with 503 `legal_entities_unavailable`.
 */

import { describe, expect, it } from "bun:test";
// The test world's environment first: the modules below read `./env` when they load.
import "../test-support/testAuth";
import { ENTITIES } from "../authz/conditions";
import { createLegalEntityRegistry, LEGAL_ENTITIES_UNAVAILABLE, parseLegalEntities } from "./legalEntities";
import { ProblemError } from "./problem";
import { createServiceTokenProvider } from "./serviceToken";

const URL_VARIABLE = "LEGAL_ENTITIES_CONTRACT_URL";
const baseUrl = process.env[URL_VARIABLE]?.replace(/\/+$/, "");
const required = process.env["LEGAL_ENTITIES_REQUIRE_CONTRACT"] === "1";
const clientId = process.env["LEGAL_ENTITIES_CONTRACT_CLIENT_ID"];
const clientSecret = process.env["LEGAL_ENTITIES_CONTRACT_CLIENT_SECRET"];
const noScopeId = process.env["LEGAL_ENTITIES_CONTRACT_NOSCOPE_CLIENT_ID"];
const noScopeSecret = process.env["LEGAL_ENTITIES_CONTRACT_NOSCOPE_CLIENT_SECRET"];

function defineContract(url: string): void {
  const provider = (id: string, secret: string) => createServiceTokenProvider({ baseUrl: url, clientId: id, clientSecret: secret });
  const registryWith = (tokens: ReturnType<typeof provider>) => createLegalEntityRegistry({ baseUrl: url, tokens });
  const get = (path: string, authorization?: string) =>
    fetch(`${url}${path}`, { headers: authorization === undefined ? {} : { Authorization: authorization }, redirect: "error", signal: AbortSignal.timeout(10_000) });

  describe(`crm-api's registry client against the real auth at ${url}`, () => {
    it("has the credential of crm-api's service client", () => {
      expect(clientId, "LEGAL_ENTITIES_CONTRACT_CLIENT_ID (crm-api's client in that auth)").toBeTruthy();
      expect(clientSecret, "LEGAL_ENTITIES_CONTRACT_CLIENT_SECRET").toBeTruthy();
    });

    it("reads both entities with a legal-entities:read token", async () => {
      const registry = registryWith(provider(clientId!, clientSecret!));
      const { entities, sentAt } = await registry.all();
      expect(typeof sentAt).toBe("number");
      expect(Object.keys(entities).sort()).toEqual([...ENTITIES].sort());
      for (const entity of ENTITIES) {
        const details = entities[entity];
        expect(details.entity).toBe(entity);
        expect(Number.isInteger(details.version) && details.version >= 0).toBe(true);
        expect(details.address.it).toBeInstanceOf(Array);
        expect(details.address.en).toBeInstanceOf(Array);
        // the print form is the electronic one in groups of four, or both are empty
        expect(details.ibanPrint.replaceAll(" ", "")).toBe(details.iban);
        // `complete` and `missing` agree
        expect(details.complete).toBe(details.missing.length === 0);
        // one read, one answer: the single-entity read is the same registry
        expect((await registry.get(entity)).version).toBe(details.version);
      }
    });

    it("the single-entity route answers the list's item, byte for byte", async () => {
      const token = await provider(clientId!, clientSecret!).getToken();
      const list = await get("/system/legal-entities", `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.headers.get("Cache-Control")).toContain("no-store");
      const items = ((await list.json()) as { items: { entity: string }[] }).items;
      expect(parseLegalEntities({ items })).not.toBeNull();
      for (const entity of ENTITIES) {
        const one = await get(`/system/legal-entities/${entity}`, `Bearer ${token}`);
        expect(one.status).toBe(200);
        expect(await one.json()).toEqual(items.find((item) => item.entity === entity));
      }
      const unknown = await get("/system/legal-entities/welld_de", `Bearer ${token}`);
      expect(unknown.status).toBe(404);
    });

    it("answers 401 without a token, and with one that is not a token", async () => {
      const bare = await get("/system/legal-entities");
      expect(bare.status).toBe(401);
      const frozen = await bare.text();
      for (const authorization of ["Bearer not-a-token", "Bearer ", "Basic abc"]) {
        const res = await get("/system/legal-entities", authorization);
        expect(res.status, authorization).toBe(401);
        expect(await res.text()).toBe(frozen);
      }
      const one = await get("/system/legal-entities/welld_ch");
      expect(one.status).toBe(401);
      expect(await one.text()).toBe(frozen);
    });

    it("a wrong secret is no token, and the client fails closed with 503 legal_entities_unavailable", async () => {
      const registry = registryWith(provider(clientId!, `${clientSecret!}-wrong`));
      try {
        await registry.all();
        throw new Error("the read did not fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProblemError);
        expect((error as ProblemError).status).toBe(503);
        expect((error as ProblemError).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
      }
    });

    if (noScopeId !== undefined && noScopeSecret !== undefined) {
      it("answers 401 to a valid service token without legal-entities:read, and the client fails closed", async () => {
        const tokens = provider(noScopeId, noScopeSecret);
        const res = await get("/system/legal-entities", `Bearer ${await tokens.getToken()}`);
        expect(res.status).toBe(401);
        const registry = registryWith(tokens);
        const error = await registry.all().then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(ProblemError);
        expect((error as ProblemError).code).toBe(LEGAL_ENTITIES_UNAVAILABLE);
      });
    } else {
      it.skip("answers 401 to a valid service token without legal-entities:read (set LEGAL_ENTITIES_CONTRACT_NOSCOPE_CLIENT_ID and _SECRET)", () => {});
    }
  });
}

// ─── Run, skip, or fail ──────────────────────────────────────────────────────────────────────────────────────────────

if (baseUrl === undefined || baseUrl === "") {
  if (required) {
    describe("legal entities contract (LEGAL_ENTITIES_REQUIRE_CONTRACT=1)", () => {
      it(`has ${URL_VARIABLE} set`, () => {
        throw new Error(
          `${URL_VARIABLE} is not set, and LEGAL_ENTITIES_REQUIRE_CONTRACT=1 says this contract test must run: ` +
            `start auth (compose) and set ${URL_VARIABLE} to its base URL (see the top of this file)`,
        );
      });
    });
  } else {
    console.warn(`[legal entities contract] SKIPPED: ${URL_VARIABLE} is not set. Set it to a running auth's base URL to run this test (LEGAL_ENTITIES_REQUIRE_CONTRACT=1 makes the skip a failure).`);
    describe.skip(`legal entities contract against the real auth (skipped: ${URL_VARIABLE} is not set)`, () => {
      it(`needs ${URL_VARIABLE}`, () => {});
    });
  }
} else {
  defineContract(baseUrl);
}
