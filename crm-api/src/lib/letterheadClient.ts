/**
 * crm-api → letterhead-api render client (specs/20261116-letterhead-service T27; AC-10.1, AC-10.3, AC-10.6 to AC-10.8; plan
 * § API contracts, § Sequences "Offer generation after the switch"; specs/20261117-legal-entities T28: AC-5.2, AC-6.2, AC-7.5).
 *
 * The layout service draws the offer's pages: the entity's active letterhead, header, footer, margins and page numbers
 * (AC-10.1). crm-api calls its render routes AS ITSELF, with the scoped 5-minute service JWT of `serviceToken.ts` (`sub
 * system:crm-api`; the scope `letterhead:render` is configured on the service client in auth, not requested here):
 *
 *   preview(content, { pages? })   POST /v1/render/preview   page images, text, page count, missing placeholders
 *   pdf(content)                   POST /v1/render/pdf       the PDF bytes and the letterhead version it was made with
 *
 * Every failure is one of two Problems, which is all a route and the UI tell apart (AC-10.6 to AC-10.8):
 *
 *   409 `letterhead_not_configured`   the service answered that the entity has no active letterhead (AC-10.8)
 *   503 `layout_service_unavailable`  anything else: not configured here, no token, unreachable, a timeout, a redirect, any
 *                                     other status (5xx, `busy`, a refused request), an answer that is not the contract's,
 *                                     the registry of the issuer's details unreadable there (`legal_entities_unavailable`),
 *                                     a service that does not know content version 2 (`unsupported_content_version`: an old
 *                                     letterhead-api during the switch push fails closed, plan decision 6)
 *
 * The content is version 2 and carries no `entityData`: the service prints the issuer from the registry itself. It carries
 * `legalEntityVersion`, the version the caller built the document from. A service that holds another version answers 409
 * `legal_entity_version_mismatch` (after refreshing its own copy once); this client throws `LegalEntityVersionMismatch`, a
 * 503 `layout_service_unavailable` for any caller that does not handle it, and the caller that does (`withIssuerPin`) drops
 * the registry's cache, rebuilds the document and the snapshot beside it, and calls ONCE more. A success whose answer does not
 * name the pinned version is not usable either: one PDF never mixes two versions of the details (decision 8).
 *
 * A caller that must not proceed without the answer (the generation, inside its transaction) lets either propagate and
 * the transaction rolls back (AC-10.6); the preview route answers it and the wizard keeps its last pages (AC-10.7).
 *
 * Bounds, so a slow or failing service cannot pile work up:
 *
 *   - 35 s in all for one call (plan § Sequences), the token exchange, the wait and the retry included;
 *   - at most ONE retry for any reason: a 401 (the cached token is dropped, the retry takes a fresh one) or a 429 `busy`
 *     (the wait is the answer's `Retry-After`, 2 s when it says none, and never more than 5 s: a longer wait is a refusal).
 *     A second 401 or 429 is the answer. No other status is retried;
 *   - redirects are refused: the request carries a credential and a document, and a redirect would replay them elsewhere.
 *
 * Nothing here logs a token, a body or any text of the document: statuses, the call and the service's error `code` only.
 * An error body is read only for the code of a 409 and of the refusals listed in `KNOWN_CODES`; text in it is never repeated.
 *
 * `letterhead` (bottom) is the one wired from the environment; tests build their own with a stubbed `fetch`.
 */

import type { LetterheadContent } from "../offers/blocks";
import { env } from "./env";
import { ProblemError } from "./problem";
import { createServiceTokenProvider, serviceTokens, type ServiceTokenProvider } from "./serviceToken";

export const LAYOUT_SERVICE_UNAVAILABLE = "layout_service_unavailable";
export const LETTERHEAD_NOT_CONFIGURED = "letterhead_not_configured";
/** The service's answer when its issuer details are not the version the content names (409, after its own refresh). */
export const LEGAL_ENTITY_VERSION_MISMATCH = "legal_entity_version_mismatch";

/** The whole call, in milliseconds (plan § Sequences: "timeout 35 s"). */
export const LETTERHEAD_TIMEOUT_MS = 35_000;
/** What `Retry-After` is taken as when the answer has none: the plan's own value for `busy`. */
const DEFAULT_RETRY_AFTER_MS = 2_000;
/** The longest wait for one retry: a service that asks for more is not waited for. */
const MAX_RETRY_AFTER_MS = 5_000;

/**
 * The service's own error codes (plan § API contracts): the closed list that may be carried as the `reason` of a 503, so
 * a log or a test can tell a busy service from a refused document. Any other value is dropped, never echoed.
 */
const KNOWN_CODES: ReadonlySet<string> = new Set([
  "busy",
  "render_timeout",
  "invalid_content",
  "content_too_large",
  "too_many_pages",
  "request_too_large",
  "header_overflow",
  "footer_overflow",
  "letterhead_version_not_found",
  "unsupported_content_version",
  "unsupported_language",
  "unknown_entity",
  "legal_entities_unavailable",
  LEGAL_ENTITY_VERSION_MISMATCH,
]);

const unavailable = (reason?: string): ProblemError =>
  new ProblemError({
    status: 503,
    code: LAYOUT_SERVICE_UNAVAILABLE,
    detail: "The layout service is unavailable; try again shortly",
    ...(reason !== undefined && KNOWN_CODES.has(reason) ? { extras: { reason } } : {}),
  });

/**
 * The service holds another version of the issuer's details than the content names. It IS the 503 `layout_service_unavailable`
 * (so a caller that does not retry fails closed), and the one the retrying caller tells apart by its class. `currentVersion` is
 * the service's own (null when its answer did not say), for the log and the tests: never sent to a person.
 */
export class LegalEntityVersionMismatch extends ProblemError {
  constructor(readonly currentVersion: number | null) {
    super({
      status: 503,
      code: LAYOUT_SERVICE_UNAVAILABLE,
      detail: "The layout service is unavailable; try again shortly",
      extras: { reason: LEGAL_ENTITY_VERSION_MISMATCH },
    });
    this.name = "LegalEntityVersionMismatch";
  }
}

const notConfigured = (entity: string): ProblemError =>
  new ProblemError({
    status: 409,
    code: LETTERHEAD_NOT_CONFIGURED,
    detail: "The entity has no active letterhead: configure one in Letterheads before rendering",
    extras: { entity },
  });

// ─── The service's answers ───────────────────────────────────────────────────────────────────────────────────────────

/** One page of a preview: the image is a base64 PNG (893 × 1263), the text is the page's reading order. */
export interface PreviewPage {
  readonly n: number;
  readonly image: string;
  readonly text: string;
}

/** The body of `POST /v1/render/preview`, unchanged. */
export interface PreviewAnswer {
  readonly letterheadVersion: number;
  /** The version of the issuer's details the service printed: the one the content named. */
  readonly legalEntityVersion: number;
  readonly pageCount: number;
  readonly missingPlaceholders: readonly string[];
  readonly unprintableCharacters: number;
  readonly pages: readonly PreviewPage[];
}

/** The answer of `POST /v1/render/pdf`: the bytes and the headers `Letterhead-Version`, `Page-Count`, … */
export interface RenderedPdf {
  readonly bytes: Uint8Array;
  /** The version of the entity's letterhead the pages were made with (AC-10.2: the offer records it). */
  readonly letterheadVersion: number;
  /** The version of the issuer's details the service printed: the one the content named. */
  readonly legalEntityVersion: number;
  readonly pageCount: number;
  readonly missingPlaceholders: readonly string[];
  readonly unprintableCharacters: number;
}

export interface RenderOptions {
  /** A version of the entity's letterhead; absent: its active one. */
  readonly letterheadVersion?: number;
}

export interface PreviewOptions extends RenderOptions {
  /** 1-based pages to return; absent: all of them. */
  readonly pages?: readonly number[];
}

export interface LetterheadClient {
  preview(content: LetterheadContent, options?: PreviewOptions): Promise<PreviewAnswer>;
  pdf(content: LetterheadContent, options?: RenderOptions): Promise<RenderedPdf>;
}

export interface LetterheadClientOptions {
  /** letterhead-api's base URL; `undefined` makes every call a 503 `layout_service_unavailable`. */
  readonly baseUrl: string | undefined;
  readonly tokens: ServiceTokenProvider | null;
  /** Looked up per call (default: the global `fetch`) so a spied global is honoured. */
  readonly fetchImpl?: typeof fetch;
  /** The whole call, retry included. */
  readonly timeoutMs?: number;
  /** The wait before the one retry (default: a timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The clock of the budget (default `Date.now`). */
  readonly now?: () => number;
}

// ─── Reading what the service sent ───────────────────────────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The `Retry-After` of an answer in milliseconds: seconds or an HTTP date; anything else is the default. */
function retryAfterMs(header: string | null, now: number): number {
  if (header === null || header.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, at - now);
}

function previewAnswer(body: unknown): PreviewAnswer | null {
  if (!isObject(body)) return null;
  const { letterheadVersion, legalEntityVersion, pageCount, missingPlaceholders, unprintableCharacters, pages } = body;
  if (!isCount(letterheadVersion) || letterheadVersion < 1 || !isCount(pageCount) || !isCount(unprintableCharacters)) return null;
  // The version of the issuer's details the pages were drawn with: an answer that does not say is not usable.
  if (!isCount(legalEntityVersion) || legalEntityVersion < 1) return null;
  if (!isStrings(missingPlaceholders) || !Array.isArray(pages)) return null;
  const read: PreviewPage[] = [];
  for (const page of pages) {
    if (!isObject(page) || !isCount(page["n"]) || typeof page["image"] !== "string" || typeof page["text"] !== "string") return null;
    read.push({ n: page["n"], image: page["image"], text: page["text"] });
  }
  return { letterheadVersion, legalEntityVersion, pageCount, missingPlaceholders, unprintableCharacters, pages: read };
}

const countHeader = (headers: Headers, name: string): number | null => {
  const value = headers.get(name);
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
};

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export function createLetterheadClient(options: LetterheadClientOptions): LetterheadClient {
  const baseUrl = options.baseUrl?.replace(/\/+$/, "");
  const tokens = options.tokens;
  const timeoutMs = options.timeoutMs ?? LETTERHEAD_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * The 2xx response, or a thrown Problem. `entity` is what a 409 `letterhead_not_configured` names (the caller's own
   * value). `ref` names the call in the log (method and path, never a body).
   */
  async function send(path: string, content: LetterheadContent, extra: RenderOptions, entity: string): Promise<Response> {
    const ref = `POST ${path.split("?")[0]}`;
    if (baseUrl === undefined || tokens === null) {
      console.error(`[letterhead] ${ref}: the layout service is not configured for the CRM`);
      throw unavailable();
    }
    if (extra.letterheadVersion !== undefined && (!Number.isInteger(extra.letterheadVersion) || extra.letterheadVersion < 1)) {
      throw new RangeError("letterheadVersion must be a positive integer");
    }
    // `letterheadVersion` is a member only when asked for: the service's default is the entity's active version.
    const body = JSON.stringify(extra.letterheadVersion === undefined ? content : { ...content, letterheadVersion: extra.letterheadVersion });
    const deadline = now() + timeoutMs;
    let retried = false;

    for (;;) {
      const left = deadline - now();
      if (left <= 0) {
        console.error(`[letterhead] ${ref} ran out of its ${timeoutMs} ms`);
        throw unavailable();
      }
      let token: string;
      try {
        token = await tokens.getToken();
      } catch (error) {
        console.error(`[letterhead] no service token for ${ref} (${error instanceof Error ? error.name : "unknown error"})`);
        throw unavailable();
      }
      let res: Response;
      try {
        const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
        res = await doFetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
          // The deadline covers reading the body too: the signal stays armed until the answer is consumed.
          signal: AbortSignal.timeout(Math.max(1, deadline - now())),
          redirect: "error",
        });
      } catch (error) {
        console.error(`[letterhead] ${ref} failed:`, error instanceof Error ? error.name : "unknown error");
        throw unavailable();
      }

      if (res.ok) return res;

      if (res.status === 401 && !retried) {
        await res.body?.cancel().catch(() => {});
        tokens.invalidate(token);
        retried = true;
        continue;
      }
      if (res.status === 429 && !retried) {
        const wait = retryAfterMs(res.headers.get("Retry-After"), now());
        await res.body?.cancel().catch(() => {});
        // A service that asks for a long wait, or a budget that cannot hold the wait and a call, is the answer.
        if (wait <= MAX_RETRY_AFTER_MS && deadline - now() > wait) {
          retried = true;
          await sleep(wait);
          continue;
        }
        console.error(`[letterhead] ${ref} answered HTTP 429 and the retry did not fit`);
        throw unavailable("busy");
      }

      const { code, currentVersion } = await errorOf(res);
      console.error(`[letterhead] ${ref} answered HTTP ${res.status}${code === null ? "" : ` (${code})`}`);
      if (res.status === 409 && code === LETTERHEAD_NOT_CONFIGURED) throw notConfigured(entity);
      if (res.status === 409 && code === LEGAL_ENTITY_VERSION_MISMATCH) throw new LegalEntityVersionMismatch(currentVersion);
      throw unavailable(res.status === 429 ? "busy" : (code ?? undefined));
    }
  }

  /**
   * The `code` of an RFC 7807 answer when it is one of the service's own, and the `currentVersion` a version mismatch names;
   * the text of the body is never read further.
   */
  async function errorOf(res: Response): Promise<{ code: string | null; currentVersion: number | null }> {
    try {
      const body = (await res.json()) as unknown;
      const code = isObject(body) ? body["code"] : undefined;
      const known = typeof code === "string" && (code === LETTERHEAD_NOT_CONFIGURED || KNOWN_CODES.has(code)) ? code : null;
      const current = isObject(body) ? body["currentVersion"] : undefined;
      return { code: known, currentVersion: known === LEGAL_ENTITY_VERSION_MISMATCH && isCount(current) && current >= 1 ? current : null };
    } catch {
      return { code: null, currentVersion: null };
    }
  }

  return {
    async preview(content, call = {}) {
      const pages = call.pages;
      if (pages !== undefined && !pages.every((page) => Number.isInteger(page) && page >= 1)) throw new RangeError("pages are positive integers");
      const query = pages !== undefined && pages.length > 0 ? `?pages=${pages.join(",")}` : "";
      const res = await send(`/v1/render/preview${query}`, content, call, content.entity);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        console.error("[letterhead] POST /v1/render/preview returned an unreadable body");
        throw unavailable();
      }
      const answer = previewAnswer(body);
      if (answer === null) {
        console.error("[letterhead] POST /v1/render/preview returned an unexpected body");
        throw unavailable();
      }
      if (content.legalEntityVersion !== undefined && answer.legalEntityVersion !== content.legalEntityVersion) {
        console.error("[letterhead] POST /v1/render/preview printed another version of the issuer's details than the one asked for");
        throw unavailable();
      }
      return answer;
    },

    async pdf(content, call = {}) {
      const res = await send("/v1/render/pdf", content, call, content.entity);
      const version = countHeader(res.headers, "Letterhead-Version");
      const issuerVersion = countHeader(res.headers, "Legal-Entity-Version");
      const pageCount = countHeader(res.headers, "Page-Count");
      const unprintable = countHeader(res.headers, "Unprintable-Characters");
      // The offer records the version it was made with (AC-10.2): an answer that does not say which is not usable.
      if (version === null || version < 1 || issuerVersion === null || issuerVersion < 1 || pageCount === null || unprintable === null || !(res.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/pdf")) {
        await res.body?.cancel().catch(() => {});
        console.error("[letterhead] POST /v1/render/pdf returned an unexpected answer");
        throw unavailable();
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch {
        console.error("[letterhead] POST /v1/render/pdf returned an unreadable body");
        throw unavailable();
      }
      if (!PDF_MAGIC.every((byte, at) => bytes[at] === byte)) {
        console.error("[letterhead] POST /v1/render/pdf returned bytes that are not a PDF");
        throw unavailable();
      }
      const listed = (res.headers.get("Missing-Placeholders") ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
      // The pin was checked by the service; an answer that names another version is one PDF of two versions: refused.
      if (content.legalEntityVersion !== undefined && issuerVersion !== content.legalEntityVersion) {
        console.error("[letterhead] POST /v1/render/pdf printed another version of the issuer's details than the one asked for");
        throw unavailable();
      }
      return { bytes, letterheadVersion: version, legalEntityVersion: issuerVersion, pageCount, missingPlaceholders: listed, unprintableCharacters: unprintable };
    },
  };
}

/**
 * The token provider of the render calls: the shared one when the CRM has it (it is built when any of the notifier,
 * estimai-api or activities-api URLs is set), else one of its own from the same service client, so a CRM that has only
 * `LETTERHEAD_API_URL` still renders. Never two caches when one exists.
 */
const tokensForLetterhead: ServiceTokenProvider | null =
  serviceTokens ??
  (env.LETTERHEAD_API_URL && env.SERVICE_CLIENT_ID && env.SERVICE_CLIENT_SECRET
    ? createServiceTokenProvider({ baseUrl: env.AUTH_BASE_URL, clientId: env.SERVICE_CLIENT_ID, clientSecret: env.SERVICE_CLIENT_SECRET })
    : null);

/** The client wired from the environment: what the routes call. */
export const letterhead: LetterheadClient = createLetterheadClient({
  baseUrl: env.LETTERHEAD_API_URL,
  tokens: tokensForLetterhead,
});
