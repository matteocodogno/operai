/**
 * The `host-notices.send` service scope end to end through the token endpoint
 * (specs/021-meetings, T3 — AC-11.8, AC-12.4): a client parsed from
 * `SERVICE_CLIENTS` with the scope gets it in its minted JWT, and an unknown
 * scope never reaches a token because the entry does not parse.
 *
 * Route logic only, with an injected signer over a throwaway in-memory key, like
 * `serviceToken.routes.test.ts` (which explains the factory and the env restore).
 * Secrets are obvious dummies.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const SERVICE_AUDIENCE = "operai-host-notices-test";
const SECRET = "dummy-host-notices-secret-0123456789-abcd";

const mutableEnv = env as unknown as Record<string, unknown>;
const saved = { audience: env.SERVICE_AUDIENCE, clients: env.SERVICE_CLIENTS };

/** Configures the env the way startup would: by parsing the raw `SERVICE_CLIENTS` JSON. */
function configureFrom(rawClients: string): void {
  const parsed = parseServiceClients(rawClients);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  mutableEnv["SERVICE_AUDIENCE"] = SERVICE_AUDIENCE;
  mutableEnv["SERVICE_CLIENTS"] = parsed.clients;
}

beforeAll(() =>
  configureFrom(
    JSON.stringify({
      "meetings-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["meetings-api"] },
    }),
  ),
);
afterAll(() => {
  mutableEnv["SERVICE_AUDIENCE"] = saved.audience;
  mutableEnv["SERVICE_CLIENTS"] = saved.clients;
});

let ipCounter = 0;
const mint = (clientId: string) =>
  router.request("/system/service-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${(ipCounter += 1)}` },
    body: JSON.stringify({ clientId, clientSecret: SECRET }),
  });

describe("host-notices.send (specs/021 — AC-11.8, AC-12.4)", () => {
  test("mints a token for meetings-api whose scope is notifications.push host-notices.send, sub system:meetings-api", async () => {
    const res = await mint("meetings-api");
    expect(res.status).toBe(200);
    const claims = decodeJwt(((await res.json()) as { token: string }).token);
    expect(claims.sub).toBe("system:meetings-api");
    expect(claims.aud).toBe(SERVICE_AUDIENCE);
    expect(claims["scope"]).toBe("notifications.push host-notices.send");
    expect(String(claims["scope"]).split(" ")).not.toContain("emails.send");
  });

  test("an unknown scope never reaches a token: the entry does not parse, so no client exists to mint for", async () => {
    const parsed = parseServiceClients(
      JSON.stringify({ "meetings-api": { secret: SECRET, scope: "notifications.push host-notices.send host-notices.admin" } }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain('"meetings-api"');

    // With the env left empty by a refused configuration, the endpoint authenticates nobody.
    mutableEnv["SERVICE_CLIENTS"] = new Map();
    try {
      expect((await mint("meetings-api")).status).toBe(401);
    } finally {
      configureFrom(
        JSON.stringify({ "meetings-api": { secret: SECRET, scope: DOCUMENTED_CLIENT_SCOPES["meetings-api"] } }),
      );
    }
  });
});
