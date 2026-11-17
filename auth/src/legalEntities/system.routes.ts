/**
 * The service read API of the legal-entity registry (specs/20261117-legal-entities, T6; AC-3.2, AC-3.4; plan
 * decisions 2-3, amendment E2):
 *
 *   GET /system/legal-entities            the two entities, in `LEGAL_ENTITIES` order
 *   GET /system/legal-entities/{entity}   one entity; 404 `unknown_legal_entity` for any other name
 *
 * The same answer as the person routes of `read.routes.ts`, by construction: the handlers call that module's
 * `readAll` / `readOne` and `unknownLegalEntity`, so the 200 bodies and the 404 are the very same serializer and
 * the very same constant. Nothing here can make them differ except the credential, which is this file's job.
 *
 * AUTH: a service JWT, and nothing else (a person's session cookie or user JWT opens nothing here). Verified in
 * process exactly as `POST /system/users/contact` does it (`userContact.routes.ts`): RS256 pinned, issuer =
 * BETTER_AUTH_URL, `aud` = SERVICE_AUDIENCE (a user JWT carries AUTH_AUDIENCE and fails), required exp/sub/aud/iss,
 * `sub` of the form `system:<client>`, and `legal-entities:read` in the space-delimited `scope`, over the same
 * cached key set (`jwksFromAuth`). EVERY failure - no header, bad signature, expired, wrong audience or scope,
 * a person's token - answers the same frozen 401, byte for byte, whichever route and whatever entity name was
 * asked for: the body carries no request path, so the 401 of `/system/legal-entities/<300 chars>` is the 401 of
 * `/system/legal-entities`.
 *
 * ORDER (the rule of `systemRateLimits.ts`: a credential is verified before any count is consulted, and exactly
 * one count is consulted):
 *   1. verify the credential (no I/O, no count);
 *   2. invalid -> the source address's shared invalid-credential count, then the 401 (or the one 429);
 *      valid -> the verified service's own `legalEntities` allowance (300 per window), then the one 429 or on;
 *   3. only then the entity name is looked at (404 for an unknown one, incl. `manageable`: plan E2) and the
 *      registry read.
 * So an unauthenticated caller learns nothing about which names exist, and a refused request reads no row.
 *
 * `/system/legal-entities/manageable` is not an entity name and does not exist here (E2): it is the same 404 as
 * `/system/legal-entities/welld_de`.
 *
 * Every answer, errors included, carries `Cache-Control: no-store` (AC-3.3: no cache between a save and a read).
 *
 * LOGGING: one line per accepted call, `[system] legal-entities.read caller=<sub>`: never the entity asked for,
 * never a value.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { errors as joseErrors, jwtVerify } from "jose";
import { env } from "../lib/env";
import { db } from "../lib/db";
import { SERVICE_SUB_PREFIX } from "../system/serviceClients";
import { callerAddress } from "../system/serviceToken.routes";
import type { SystemRateLimits } from "../system/systemRateLimits";
import { type GetServiceJwks, MAX_TOKEN_CHARS } from "../system/userContact.routes";
import { isLegalEntity, NO_STORE, readAll, readOne, unknownLegalEntity } from "./read.routes";
import type { Reader } from "./repo";

export const LEGAL_ENTITIES_READ_SCOPE = "legal-entities:read";

/**
 * The one 401 of this module: a constant, so it cannot depend on the request (no path, no name) nor on which
 * check failed.
 */
export const FROZEN_UNAUTHORIZED_BODY = Object.freeze({
  type: "https://httpstatuses.com/401",
  title: "Unauthorized",
  status: 401,
  detail: "Valid credentials are required",
  instance: "/system/legal-entities",
});

// ─── API document (the handlers below own the order, so these are registered for the document only) ──────────

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string().optional(),
  code: z.string().optional(),
});

const LegalEntityRef = z.object({ entity: z.string() }).passthrough().openapi("LegalEntityServiceAnswer");

const responses = (ok: z.ZodType, withNotFound: boolean) => ({
  200: { content: { "application/json": { schema: ok } }, description: "Same body as the person route" },
  401: {
    content: { "application/json": { schema: ProblemSchema } },
    description: "Missing or invalid service credential (identical for every failure)",
  },
  ...(withNotFound
    ? {
        404: {
          content: { "application/problem+json": { schema: ProblemSchema } },
          description: "`unknown_legal_entity`: a fixed body, the requested name is never echoed",
        },
      }
    : {}),
  429: { content: { "application/json": { schema: ProblemSchema } }, description: "Per-service allowance exceeded" },
});

const listRoute = createRoute({
  method: "get",
  path: "/system/legal-entities",
  tags: ["System"],
  summary: "The group's legal entities (service principals only)",
  description:
    "Service-to-service only: needs a service JWT (aud SERVICE_AUDIENCE) with scope `legal-entities:read`. " +
    "The body is byte-equal to `GET /legal-entities`.",
  responses: responses(z.object({ items: z.array(LegalEntityRef) }), false),
});

const oneRoute = createRoute({
  method: "get",
  path: "/system/legal-entities/{entity}",
  tags: ["System"],
  summary: "One legal entity (service principals only)",
  description:
    "Service-to-service only, same credential as the list. The body is byte-equal to `GET /legal-entities/{entity}`.",
  request: { params: z.object({ entity: z.string() }) },
  responses: responses(LegalEntityRef, true),
});

// ─── Router ──────────────────────────────────────────────────────────────────

/**
 * @param deps.getJwks the key source (`jwksFromAuth(auth)` in production; a local key set in tests, so this module
 *   never imports `auth.config`)
 * @param deps.limits the one set of `/system` limits `index.ts` shares between its routers
 * @param deps.client the client the registry is read through; `db` unless a test reads through its rolled-back
 *   transaction
 */
export function createSystemLegalEntitiesRouter(deps: {
  getJwks: GetServiceJwks;
  limits: SystemRateLimits;
  client?: Reader;
}) {
  const { limits } = deps;
  const client = deps.client ?? db;

  /** The verified calling service, or `failure` (the jose error code when there is one, for the log line). */
  type Verdict = { valid: true; sub: string } | { valid: false; failure: string | null };

  async function verify(authorization: string | undefined): Promise<Verdict> {
    const audience = env.SERVICE_AUDIENCE;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!audience || !token || token.length > MAX_TOKEN_CHARS) return { valid: false, failure: null };
    try {
      const { payload } = await jwtVerify(token, await deps.getJwks(), {
        issuer: env.BETTER_AUTH_URL,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub", "aud", "iss"],
      });
      const sub = payload.sub;
      const scope = payload["scope"];
      if (
        typeof sub !== "string" ||
        !sub.startsWith(SERVICE_SUB_PREFIX) ||
        sub.length === SERVICE_SUB_PREFIX.length ||
        typeof scope !== "string" ||
        !scope.split(" ").includes(LEGAL_ENTITIES_READ_SCOPE)
      ) {
        return { valid: false, failure: null };
      }
      return { valid: true, sub };
    } catch (err) {
      // The jose error code only: nothing about the presented credential.
      const code = err instanceof joseErrors.JOSEError ? (err.code ?? err.constructor.name) : "JWT_VERIFY_FAILED";
      return { valid: false, failure: code };
    }
  }

  /** Steps 1 and 2: `null` when the caller may go on, else the response that ends the request. */
  async function admit(c: Context): Promise<Response | null> {
    const verdict = await verify(c.req.header("Authorization"));
    if (!verdict.valid) {
      const source = callerAddress(c.req.header("X-Forwarded-For"));
      if (!limits.invalidCredentials.consume(source).allowed) {
        limits.logRefusal("invalid", "legal-entities", source);
        return limits.tooManyRequests(c);
      }
      if (verdict.failure !== null) console.warn("[system-jwt] verification failed:", verdict.failure);
      return c.body(JSON.stringify(FROZEN_UNAUTHORIZED_BODY), 401, {
        "Content-Type": "application/json",
        "Cache-Control": NO_STORE,
      });
    }
    if (!limits.legalEntities.consume(verdict.sub).allowed) {
      limits.logRefusal("allowance", "legal-entities", verdict.sub);
      return limits.tooManyRequests(c);
    }
    console.log(`[system] legal-entities.read caller=${verdict.sub}`);
    return null;
  }

  // Not `.openapi()`: its param validation would run before any credential check or count. The routes are
  // registered for the API document only.
  const router = new OpenAPIHono();
  router.openAPIRegistry.registerPath(listRoute);
  router.openAPIRegistry.registerPath(oneRoute);

  router.get("/system/legal-entities", async (c) => {
    const refusal = await admit(c);
    if (refusal) return refusal;
    c.header("Cache-Control", NO_STORE);
    return c.json(await readAll(client), 200);
  });

  // `:entity` also matches `manageable`, which is not an entity name (E2): the same 404 as any other.
  router.get("/system/legal-entities/:entity", async (c) => {
    const refusal = await admit(c);
    if (refusal) return refusal;
    const entity = c.req.param("entity");
    if (!isLegalEntity(entity)) return unknownLegalEntity(c);
    c.header("Cache-Control", NO_STORE);
    return c.json(await readOne(entity, client), 200);
  });

  return router;
}
