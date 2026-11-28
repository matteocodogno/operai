/**
 * The `meeting-hours-notices.send` service scope and the `meetings-api` client end to end
 * through the token endpoint (specs/20261112-meeting-hours, T1 — AC-1.6, AC-1.7; ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older):
 * a client parsed from `SERVICE_CLIENTS` with the scope gets exactly it, beside the scopes it already
 * had, in its minted JWT, and an unknown scope never reaches a token because the entry does not parse.
 * hours-api's `POST /system/meeting-hours/v1/notices` verifies it and checks the `sub` against its own
 * allowlist `system:meetings-api`; only meetings-api holds it.
 *
 * Same shape as `serviceClients.meetingsHostsRead.test.ts` (injected signer over a throwaway
 * in-memory key; secrets are obvious dummies).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import type { ServiceJwtPayload } from "./serviceToken.routes";
import { DOCUMENTED_CLIENT_SCOPES, KNOWN_SERVICE_SCOPES, parseServiceClients } from "./serviceClients";

const { env } = await import("../lib/env");
const { createServiceTokenRouter } = await import("./serviceToken.routes");
const { createSystemRateLimits } = await import("./systemRateLimits");

const { privateKey } = await generateKeyPair("RS256");
const signJwt = async (payload: ServiceJwtPayload): Promise<string> =>
  new SignJWT({ scope: payload.scope })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(payload.iss)
    .setSubject(payload.sub)
    .setAudience(payload.aud)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .setJti(payload.jti)
    .sign(privateKey);

const router = createServiceTokenRouter({ signJwt, limits: createSystemRateLimits() });

const SERVICE_AUDIENCE = "operai-meeting-hours-test";
const SECRET = "dummy-meeting-hours-secret-0123456789-abcd";
const SCOPE = "meeting-hours-notices.send";

const mutableEnv = env as unknown as Record<string, unknown>;
const saved = { audience: env.SERVICE_AUDIENCE, clients: env.SERVICE_CLIENTS };

const documentedClients = () =>
  JSON.stringify({
    "meetings-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["meetings-api"] },
    "hours-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["hours-api"] },
    "crm-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["crm-api"] },
    "activities-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["activities-api"] },
    "projects-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["projects-api"] },
  });

/** Configures the env the way startup would: by parsing the raw `SERVICE_CLIENTS` JSON. */
function configureFrom(rawClients: string): void {
  const parsed = parseServiceClients(rawClients);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  mutableEnv["SERVICE_AUDIENCE"] = SERVICE_AUDIENCE;
  mutableEnv["SERVICE_CLIENTS"] = parsed.clients;
}

beforeAll(() => configureFrom(documentedClients()));
afterAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = saved.audience;
  mutableEnv["SERVICE_CLIENTS"] = saved.clients;
});

let ipCounter = 0;
const mint = (clientId: string) =>
  router.request("/system/service-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${(ipCounter += 1)}` },
    body: JSON.stringify({ clientId, clientSecret: SECRET }),
  });

describe(`${SCOPE} (specs/20261112-meeting-hours — AC-1.6, AC-1.7)`, () => {
  test("is a known service scope", () => {
    expect(KNOWN_SERVICE_SCOPES as readonly string[]).toContain(SCOPE);
  });

  test("a token minted for meetings-api has sub system:meetings-api, aud = SERVICE_AUDIENCE and exactly its three scopes", async () => {
    const res = await mint("meetings-api");
    expect(res.status).toBe(200);
    const claims = decodeJwt(((await res.json()) as { token: string }).token);
    expect(claims.sub).toBe("system:meetings-api");
    expect(claims.aud).toBe(SERVICE_AUDIENCE);
    expect(claims["scope"]).toBe("notifications.push host-notices.send meeting-hours-notices.send");
    expect(String(claims["scope"]).split(" ")).not.toContain("emails.send");
  });

  test("no other documented client's token carries it", async () => {
    for (const clientId of ["hours-api", "crm-api", "activities-api", "projects-api"]) {
      const res = await mint(clientId);
      expect(res.status).toBe(200);
      const claims = decodeJwt(((await res.json()) as { token: string }).token);
      expect(String(claims["scope"]).split(" ")).not.toContain(SCOPE);
    }
  });

  test("an unknown scope never reaches a token: the entry does not parse, so no client exists to mint for", async () => {
    const parsed = parseServiceClients(
      JSON.stringify({
        "meetings-api": { secret: SECRET, scope: `notifications.push host-notices.send ${SCOPE} meeting-hours-notices.admin` },
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain('"meetings-api"');
      expect(parsed.errors.join("\n")).not.toContain(SECRET);
    }

    // With the env left empty by a refused configuration, the endpoint authenticates nobody.
    mutableEnv["SERVICE_CLIENTS"] = new Map();
    try {
      expect((await mint("meetings-api")).status).toBe(401);
    } finally {
      configureFrom(documentedClients());
    }
  });
});

describe("auth/.env.example documents the meetings-api client (specs/20261112-meeting-hours T1)", () => {
  /** The commented `# SERVICE_CLIENTS='{…}'` example line, parsed with the startup parser. */
  function exampleClients() {
    const text = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const line = text.split("\n").find((l) => l.startsWith("# SERVICE_CLIENTS='"));
    if (!line) throw new Error("auth/.env.example has no `# SERVICE_CLIENTS='…'` example line");
    const json = line.slice("# SERVICE_CLIENTS='".length, line.lastIndexOf("'"));
    const parsed = parseServiceClients(json);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.clients;
  }

  test("the example parses, and carries meetings-api with exactly its documented scopes, the new one included", () => {
    const clients = exampleClients();
    expect(clients.get("meetings-api")?.scopes).toEqual([
      "notifications.push",
      "host-notices.send",
      "meeting-hours-notices.send",
    ]);
  });

  test("no other client of the example holds the scope", () => {
    const holders = [...exampleClients()]
      .filter(([, client]) => client.scopes.includes(SCOPE))
      .map(([clientId]) => clientId);
    expect(holders).toEqual(["meetings-api"]);
  });

  test("every documented client the example lists holds exactly its documented scopes", () => {
    const documented: Record<string, string> = DOCUMENTED_CLIENT_SCOPES;
    for (const [clientId, client] of exampleClients()) {
      const expected = documented[clientId];
      if (expected === undefined) continue;
      expect([...client.scopes].sort()).toEqual(expected.split(" ").sort());
    }
  });
});
