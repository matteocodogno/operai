/**
 * Synchronous residency checks for the AI providers (specs/021-meetings AC-4.9,
 * plan.md § Amendment 2026-11-05 G-5, ADR-0069). Pure functions over the
 * configured strings: `env.ts` runs them while parsing, so a misconfiguration
 * stops the process before it listens.
 *
 * A refusal NAMES the variable and never echoes the value it refused: the
 * startup output is read by operators and by log aggregators, and a location is
 * configuration, but the habit of printing offending values is how a key ends up
 * in a log line.
 *
 * The checks that need the network (the transient bucket, Vertex caching and
 * request-response logging) are startup checks of their own (`startupChecks.ts`);
 * this file is what can be decided from the environment alone (S1-S5).
 */

/** S1. Chirp 3 is generally available in `eu` and `us` only; `us` is outside the permitted jurisdiction. */
export const SPEECH_ALLOWED_LOCATIONS = ["eu"] as const;

/**
 * S2. Vertex locations whose data stays in the EU: the `eu` multi-region (current Claude models) and the two
 * single regions Google lists for older ones. `global` gives no residency guarantee and is never allowed;
 * London (`europe-west2`) is not EU.
 */
export const VERTEX_ALLOWED_LOCATIONS = ["eu", "europe-west1", "europe-west4"] as const;

/** S1: `null` when `location` is the one allowed Speech location. */
export function checkSpeechLocation(location: string): string | null {
  return (SPEECH_ALLOWED_LOCATIONS as readonly string[]).includes(location)
    ? null
    : `MEETINGS_SPEECH_LOCATION is not an allowed location. Allowed: ${SPEECH_ALLOWED_LOCATIONS.join(", ")}`;
}

/** S2: `null` when `location` is an EU Vertex location. */
export function checkVertexLocation(location: string): string | null {
  return (VERTEX_ALLOWED_LOCATIONS as readonly string[]).includes(location)
    ? null
    : `MEETINGS_VERTEX_LOCATION is not an allowed EU location. Allowed: ${VERTEX_ALLOWED_LOCATIONS.join(", ")}`;
}

/**
 * S3: a Claude model id that is not designated "Advanced AI" by Vertex (Fable and Mythos: prompt and response
 * logging for up to 30 days that may not be possible to opt out of).
 */
export function checkVertexModelId(modelId: string): string | null {
  if (!/^claude-[a-z0-9.@-]+$/.test(modelId)) {
    return "MEETINGS_VERTEX_MODEL_ID must be a Claude model id (claude-...)";
  }
  if (/fable|mythos/i.test(modelId)) {
    return "MEETINGS_VERTEX_MODEL_ID names a model that Google retains prompts and responses for; it is refused";
  }
  return null;
}

/** A Google Cloud project id: 6-30 chars, lowercase letters, digits and hyphens, starting with a letter. */
export const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** A Cloud Storage bucket name (3-63 chars; letters, digits, `-`, `_`, `.`; not an IP-like name). */
export const GCS_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

/** The members of a service-account key this service uses. */
export interface ServiceAccountKey {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
}

/**
 * S4: decodes `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` (base64 of the key's JSON). `error` names the problem and never
 * a value; `key` is the parsed key otherwise. The caller keeps `key` away from logs.
 */
export function parseServiceAccountKey(
  encoded: string,
  projectId: string | undefined,
): { readonly key: ServiceAccountKey; readonly error?: undefined } | { readonly key?: undefined; readonly error: string } {
  const fail = (error: string) => ({ error });
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return fail("MEETINGS_GCP_SERVICE_ACCOUNT_KEY is not base64");
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return fail("MEETINGS_GCP_SERVICE_ACCOUNT_KEY does not decode to JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return fail("MEETINGS_GCP_SERVICE_ACCOUNT_KEY does not decode to a JSON object");
  }
  const o = json as Record<string, unknown>;
  if (o["type"] !== "service_account") return fail("MEETINGS_GCP_SERVICE_ACCOUNT_KEY is not a service_account key");
  if (typeof o["project_id"] !== "string" || o["project_id"] === "") {
    return fail("MEETINGS_GCP_SERVICE_ACCOUNT_KEY has no project_id");
  }
  if (projectId !== undefined && o["project_id"] !== projectId) {
    return fail("MEETINGS_GCP_SERVICE_ACCOUNT_KEY belongs to a different project than MEETINGS_GCP_PROJECT_ID");
  }
  if (typeof o["client_email"] !== "string" || o["client_email"] === "") {
    return fail("MEETINGS_GCP_SERVICE_ACCOUNT_KEY has no client_email");
  }
  if (typeof o["private_key"] !== "string" || o["private_key"] === "") {
    return fail("MEETINGS_GCP_SERVICE_ACCOUNT_KEY has no private_key");
  }
  return { key: { projectId: o["project_id"], clientEmail: o["client_email"], privateKey: o["private_key"] } };
}

/**
 * S5: `null` when no ambient Vertex base-URL override is set. The adapter passes its own base URL, but an
 * override left in the environment is a misconfiguration worth stopping on (R13).
 */
export function checkNoVertexBaseUrlOverride(value: string | undefined): string | null {
  return value === undefined || value === ""
    ? null
    : "ANTHROPIC_VERTEX_BASE_URL must not be set: the Vertex base URL is derived from MEETINGS_VERTEX_LOCATION";
}

/** The Vertex host for an allowed location: the `eu` multi-region has its own `rep` host. */
export function vertexHost(location: string): string {
  return location === "eu" ? "aiplatform.eu.rep.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}
