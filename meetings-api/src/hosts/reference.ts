/**
 * Turning a host reference into a verified one (specs/021-meetings plan.md § Host
 * integration contract; AC-1.1, AC-1.5, AC-1.6, AC-1.7, AC-11.6). Creating a meeting with a
 * host, relinking one, and `GET /hosts/:app/:type/:id` all ask the same question, so they
 * share this one answer:
 *
 *   not a registered host          422 `host_not_registered`
 *   the host cannot answer         503 `host_unavailable` (fail CLOSED: never allowed unverified)
 *   missing OR closed for this caller   422 `host_entity_not_found`, one and the same answer,
 *                                  so the response cannot tell a caller which it was (AC-1.5)
 *
 * The question is asked AS THE CALLER, with their own JWT, and never cached.
 */

import { resolve as resolveAtHost } from "./client";
import { hostRegistry, type HostDefinition, type HostEntity, type HostRegistry } from "./registry";
import { ProblemError, unprocessable } from "../lib/problem";

export interface HostReference {
  readonly app: string;
  readonly entityType: string;
  readonly entityId: string;
}

export interface ReferenceDeps {
  readonly registry?: Pick<HostRegistry, "get">;
  readonly resolveHost?: typeof resolveAtHost;
}

export interface VerifiedHost {
  readonly definition: HostDefinition;
  readonly entity: HostEntity & { readonly state: "open" };
}

export const hostNotRegistered = (): ProblemError =>
  unprocessable("This is not a known host", { field: "host" }, "host_not_registered");

export const hostEntityNotFound = (): ProblemError =>
  unprocessable("The host entity does not exist or you cannot open it", { field: "host" }, "host_entity_not_found");

export const hostUnavailable = (): ProblemError =>
  new ProblemError({ status: 503, code: "host_unavailable", detail: "The host could not confirm the entity right now; try again" });

/** The registered definition for a reference, or the 422. */
export function requireHost(app: string, entityType: string, deps: ReferenceDeps = {}): HostDefinition {
  const definition = (deps.registry ?? hostRegistry()).get(app, entityType);
  if (!definition) throw hostNotRegistered();
  return definition;
}

/** Verifies `reference` as the caller, or throws one of the three answers above. */
export async function verifyHostReference(
  reference: HostReference,
  authorization: string,
  deps: ReferenceDeps = {},
): Promise<VerifiedHost> {
  const definition = requireHost(reference.app, reference.entityType, deps);
  const answer = await (deps.resolveHost ?? resolveAtHost)(definition, authorization, [reference.entityId]);
  if (answer.state === "unavailable") throw hostUnavailable();
  const entity = answer.entities.get(reference.entityId);
  if (entity?.state !== "open") throw hostEntityNotFound();
  return { definition, entity: entity as VerifiedHost["entity"] };
}
