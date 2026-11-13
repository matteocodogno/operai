/**
 * The `meetings.hosts.read` service scope and the `hours-api` client end to end
 * through the token endpoint (specs/029-time-tracking, T2 — AC-2.6, AC-4.5,
 * AC-4.11; ADR-0089): a client parsed from `SERVICE_CLIENTS` with the scope gets
 * exactly it in its minted JWT, and an unknown scope never reaches a token
 * because the entry does not parse.
 *
 * Same shape as `serviceClients.activitiesWrite.test.ts` (injected signer over a
 * throwaway in-memory key; secrets are obvious dummies).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import type { ServiceJwtPayload } from "./serviceToken.routes";
import { DOCUMENTED_CLIENT_SCOPES, parseServiceClients } from "./serviceClients";

const { env } = await import("../lib/env");
const { createServiceTokenRouter } = await import("./serviceToken.routes");

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

const router = createServiceTokenRouter({ signJwt });

const SERVICE_AUDIENCE = "operai-hours-test";
const SECRET = "dummy-hours-api-secret-0123456789-abcdefgh";

const mutableEnv = env as unknown as Record<string, unknown>;
const saved = { audience: env.SERVICE_AUDIENCE, clients: env.SERVICE_CLIENTS };

const documentedClients = () =>
  JSON.stringify({
    "hours-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["hours-api"] },
    "meetings-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["meetings-api"] },
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
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `192.0.2.${(ipCounter += 1)}` },
    body: JSON.stringify({ clientId, clientSecret: SECRET }),
  });

describe("meetings.hosts.read (specs/029 — AC-2.6, AC-4.5, AC-4.11)", () => {
  test("a token minted for hours-api has sub system:hours-api, aud = SERVICE_AUDIENCE and scope exactly meetings.hosts.read", async () => {
    const res = await mint("hours-api");
    expect(res.status).toBe(200);
    const claims = decodeJwt(((await res.json()) as { token: string }).token);
    expect(claims.sub).toBe("system:hours-api");
    expect(claims.aud).toBe(SERVICE_AUDIENCE);
    expect(claims["scope"]).toBe("meetings.hosts.read");
  });

  test("no other documented client's token carries meetings.hosts.read", async () => {
    for (const clientId of ["meetings-api", "crm-api", "activities-api", "projects-api"]) {
      const res = await mint(clientId);
      expect(res.status).toBe(200);
      const claims = decodeJwt(((await res.json()) as { token: string }).token);
      expect(String(claims["scope"]).split(" ")).not.toContain("meetings.hosts.read");
    }
  });

  test("an unknown scope never reaches a token: the entry does not parse, so no client exists to mint for", async () => {
    const parsed = parseServiceClients(
      JSON.stringify({ "hours-api": { secret: SECRET, scope: "meetings.hosts.read meetings.hosts.write" } }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain('"hours-api"');

    mutableEnv["SERVICE_CLIENTS"] = new Map();
    try {
      expect((await mint("hours-api")).status).toBe(401);
    } finally {
      configureFrom(documentedClients());
    }
  });
});

describe("auth/.env.example documents the hours-api client (specs/029 T2)", () => {
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

  test("the example parses, and carries hours-api with exactly its documented scope", () => {
    const clients = exampleClients();
    expect(clients.get("hours-api")?.scopes).toEqual(["meetings.hosts.read"]);
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
