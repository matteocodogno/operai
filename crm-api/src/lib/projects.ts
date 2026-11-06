/**
 * crm-api's read of projects-api (specs/022-projects-handoff T10, T21, AC-3.4, ADR-0060): the deal
 * page shows the project that carries a deal and its purchase order's Bexio order id, read-only.
 * crm-api calls `GET /system/purchase-orders?dealIds=` as ITSELF, with the 5-minute scoped service
 * JWT (`projects.purchase-orders.read`) its own `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` buy
 * at auth — never the viewer's token: a CRM user may hold no `projects:access`, and projects-api
 * accepts no user JWT on that route.
 *
 * projects-api answers `{ items: [{ dealId, purchaseOrderId, project: { id, name }, bexioOrderId }] }`
 * (T23; it was `contractId` before the rename). The deal page needs only the project and the Bexio
 * order id, so `purchaseOrderId` is not read: the `Delivery` shape, `GET /deals/{id}`'s `delivery` /
 * `deliveryKnown` and crm-ui are unchanged.
 *
 * STRICTLY FAIL-SOFT: nothing here throws. The answer says whether projects-api spoke at all:
 *   `{ known: true,  delivery }`  projects-api answered; `delivery` is `null` for a deal no project carries;
 *   `{ known: false, delivery: null }`  projects-api is not configured, down, refused us, or answered
 *                                 nonsense — the deal still loads and the UI says "unavailable".
 *
 * Whatever goes wrong is logged as an HTTP status or an error name only: never a token, the secret
 * or a response body. One 401 drops the cached token and retries ONCE with a fresh one.
 *
 * Its own token provider (`createServiceTokenProvider`, imported, not edited): the module-level
 * `serviceTokens` of `serviceToken.ts` exists only when the notifier is configured, and the deal
 * page must not depend on that.
 */

import { env } from "./env";
import { createServiceTokenProvider, type ServiceTokenProvider } from "./serviceToken";

const REQUEST_TIMEOUT_MS = 3_000;

/** What the deal page shows of the purchase order made from a deal. */
export interface Delivery {
  readonly project: { readonly id: string; readonly name: string };
  readonly bexioOrderId: string | null;
}

export interface DeliveryRead {
  /** Whether projects-api answered. `false` means "unknown", not "no project". */
  readonly known: boolean;
  readonly delivery: Delivery | null;
}

export interface ProjectsReader {
  /** Never throws, never rejects. */
  deliveryOf(dealId: string): Promise<DeliveryRead>;
}

export interface ProjectsReaderOptions {
  readonly baseUrl: string;
  readonly tokens: ServiceTokenProvider;
  /** Looked up per call (default: the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const UNKNOWN: DeliveryRead = { known: false, delivery: null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The deal's delivery out of projects-api's `{ items }`, or `undefined` when the body is not that shape. */
function parseDelivery(body: unknown, dealId: string): DeliveryRead | undefined {
  if (!isRecord(body) || !Array.isArray(body["items"])) return undefined;
  const item: unknown = body["items"].find((candidate) => isRecord(candidate) && candidate["dealId"] === dealId);
  if (item === undefined) return { known: true, delivery: null };
  if (!isRecord(item)) return undefined;
  const project = item["project"];
  if (!isRecord(project) || typeof project["id"] !== "string" || typeof project["name"] !== "string") return undefined;
  const bexio = item["bexioOrderId"];
  return {
    known: true,
    delivery: {
      project: { id: project["id"], name: project["name"] },
      bexioOrderId: typeof bexio === "string" && bexio !== "" ? bexio : null,
    },
  };
}

export function createProjectsReader(options: ProjectsReaderOptions): ProjectsReader {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function get(token: string, dealId: string): Promise<Response> {
    const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    return doFetch(`${options.baseUrl}/system/purchase-orders?dealIds=${encodeURIComponent(dealId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  }

  return {
    async deliveryOf(dealId) {
      try {
        for (let attempt = 0; ; attempt++) {
          const token = await options.tokens.getToken();
          const res = await get(token, dealId);
          if (res.status === 401 && attempt === 0) {
            await res.body?.cancel().catch(() => {});
            options.tokens.invalidate(token);
            continue;
          }
          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            console.error(`[projects] projects-api answered HTTP ${res.status} for deal=${dealId} — delivery unknown`);
            return UNKNOWN;
          }
          const parsed = parseDelivery(await res.json().catch(() => null), dealId);
          if (!parsed) console.error(`[projects] projects-api returned an unreadable body for deal=${dealId} — delivery unknown`);
          return parsed ?? UNKNOWN;
        }
      } catch (error) {
        // Messages come from our own ServiceTokenError (status only) or the runtime's fetch
        // error; neither can contain the secret or a token.
        console.error(
          `[projects] could not read the delivery of deal=${dealId} — delivery unknown:`,
          error instanceof Error ? error.message : "unknown error",
        );
        return UNKNOWN;
      }
    },
  };
}

// ─── The wired instance ──────────────────────────────────────────────────────

export interface ProjectsEnv {
  readonly PROJECTS_INTERNAL_URL?: string | undefined;
  readonly SERVICE_CLIENT_ID?: string | undefined;
  readonly SERVICE_CLIENT_SECRET?: string | undefined;
  readonly AUTH_BASE_URL: string;
}

/** From the environment; `null` when `PROJECTS_INTERNAL_URL` or the service client is absent. */
export function projectsReaderFromEnv(source: ProjectsEnv, fetchImpl?: typeof fetch): ProjectsReader | null {
  if (!source.PROJECTS_INTERNAL_URL || !source.SERVICE_CLIENT_ID || !source.SERVICE_CLIENT_SECRET) return null;
  return createProjectsReader({
    baseUrl: source.PROJECTS_INTERNAL_URL,
    tokens: createServiceTokenProvider({
      baseUrl: source.AUTH_BASE_URL,
      clientId: source.SERVICE_CLIENT_ID,
      clientSecret: source.SERVICE_CLIENT_SECRET,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * Disabled under `NODE_ENV=test`, like the notifier: `bun test` shares one process and a developer's
 * env may hold real `SERVICE_CLIENT_*` and `PROJECTS_INTERNAL_URL`, so route tests must never call a
 * real projects-api. Tests of the read build their own reader over a stubbed network.
 */
let current: ProjectsReader | null = env.NODE_ENV === "test" ? null : projectsReaderFromEnv(env);

if (env.NODE_ENV !== "test" && current === null) {
  console.log("[projects] PROJECTS_INTERNAL_URL / SERVICE_CLIENT_* not set — the deal page will not show its project");
}

/** Tests only: swap in a reader, `null` for "not configured", `undefined` for the default (off under test). */
export function setProjectsReaderForTests(reader: ProjectsReader | null | undefined): void {
  current = reader === undefined ? (env.NODE_ENV === "test" ? null : projectsReaderFromEnv(env)) : reader;
}

/** The deal's delivery; `known: false` when projects-api is not configured or does not answer. Never throws. */
export async function deliveryOfDeal(dealId: string): Promise<DeliveryRead> {
  return current ? current.deliveryOf(dealId) : UNKNOWN;
}
