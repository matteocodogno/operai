/**
 * The host registry (specs/021-meetings plan.md § Host integration contract,
 * ADR-0059). A host is DATA, never a branch in a route: the meeting screens
 * render any host from `GET /hosts`, which is what makes AC-11.4 ("a new host
 * needs no change to the meeting screens") true by construction.
 *
 * Production contains EXACTLY `crm/deal` (AC-11.1). `MEETINGS_TEST_HOSTS` adds test
 * hosts in dev and test only: env.ts refuses it in production, and this module
 * ignores it there too (defence in depth).
 *
 * This file also holds the TYPES of the host contract (`HostEntity`, `HostNotice`,
 * results), so `client.ts` can export nothing but its two functions.
 */

import { z } from "zod";
import { env } from "../lib/env";

// ─── Registry entries ───────────────────────────────────────────────────────

export type HostLanguage = "en" | "it";

export interface HostLabels {
  /** "CRM" */
  readonly app: string;
  /** "Deal" | "Opportunità" */
  readonly entity: string;
  /** G6, shown next to the host-visible checkbox: "and can see deal financials" */
  readonly visibilityHint: string;
  /** G7, shown to the creator when the notice failed: "The deal's activity could not be added" */
  readonly noticeFailed: string;
}

export interface HostDefinition {
  readonly app: string;
  readonly entityType: string;
  /** From env (CRM_API_URL, Railway private DNS). */
  readonly baseUrl: string;
  readonly labels: Readonly<Record<HostLanguage, HostLabels>>;
  readonly offersHostVisible: boolean;
  /** Documentation only: what the host demands for a host-visible reader (enforced by the host's answer). */
  readonly hostVisibleRequirement: string;
  readonly notices: boolean;
  readonly recommendedTemplates: readonly string[];
  readonly contract: 1;
}

/** The part of a definition `GET /hosts` serves: never the base URL. */
export interface PublicHost {
  readonly app: string;
  readonly entityType: string;
  readonly labels: Readonly<Record<HostLanguage, HostLabels>>;
  readonly offersHostVisible: boolean;
  readonly recommendedTemplates: readonly string[];
}

export const publicView = (host: HostDefinition): PublicHost => ({
  app: host.app,
  entityType: host.entityType,
  labels: host.labels,
  offersHostVisible: host.offersHostVisible,
  recommendedTemplates: host.recommendedTemplates,
});

// ─── The host contract's types (ADR-0059) ───────────────────────────────────

/** What a host answers about one entity, for one caller. */
export interface HostEntity {
  readonly state: "open" | "closed" | "missing";
  /** Only when `open`. */
  readonly title?: string;
  /** Only when `open`: a path inside the suite, e.g. `/crm/deals/<id>`. */
  readonly href?: string;
  /** Only when `open`: whether the caller holds what the host requires for host-visible meetings. */
  readonly hostVisible?: boolean;
}

/** `unavailable` = any 5xx, timeout, malformed body or transport error: callers fail closed for a grant. */
export type ResolveResult =
  | { readonly state: "ok"; readonly entities: ReadonlyMap<string, HostEntity> }
  | { readonly state: "unavailable" };

export type NoticeEventName = "linked" | "changed" | "unlinked" | "deleted";

/** The body of a host notice, exactly (the host answers 422 to any other key). */
export interface HostNotice {
  /** uuid; the host's idempotency key. */
  readonly noticeId: string;
  /** Monotonic per meeting. */
  readonly seq: number;
  readonly event: NoticeEventName;
  readonly meeting: {
    readonly id: string;
    /** null for `unlinked` / `deleted`: nothing with a title survives a deletion (AC-4.6). */
    readonly title: string | null;
    readonly startsAt: string | null;
    readonly creatorId: string;
  };
  readonly entity: { readonly type: string; readonly id: string };
}

export type NoticeFailureCode =
  | "notices_not_supported"
  | "entity_not_found"
  | "unauthorized"
  | "rejected"
  | "unavailable"
  | "timeout"
  | "malformed";

export type NoticeResult =
  | { readonly state: "delivered"; readonly applied: boolean }
  | {
      readonly state: "failed";
      /** A permanent failure will never succeed by retrying (the host says the entity is gone, or refuses the body). */
      readonly permanent: boolean;
      readonly code: NoticeFailureCode;
    };

// ─── CRM: the one production host ───────────────────────────────────────────

const crmDefinition = (baseUrl: string): HostDefinition => ({
  app: "crm",
  entityType: "deal",
  baseUrl,
  labels: {
    en: {
      app: "CRM",
      entity: "Deal",
      visibilityHint: "and can see deal financials",
      noticeFailed: "The deal's activity could not be added",
    },
    it: {
      app: "CRM",
      entity: "Opportunità",
      visibilityHint: "e possono vedere i dati economici dell'opportunità",
      noticeFailed: "Non è stato possibile aggiungere l'attività all'opportunità",
    },
  },
  offersHostVisible: true,
  hostVisibleRequirement: "deal:financials",
  notices: true,
  recommendedTemplates: ["builtin:sales-discovery"],
  contract: 1,
});

// ─── Test hosts (MEETINGS_TEST_HOSTS) ───────────────────────────────────────

const slug = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const labelSet = z.object({ app: z.string().min(1), entity: z.string().min(1), visibilityHint: z.string(), noticeFailed: z.string() }).strict();
const testHostSchema = z
  .object({
    app: slug,
    entityType: slug,
    baseUrl: z.string().url(),
    labels: z.object({ en: labelSet, it: labelSet }).strict(),
    offersHostVisible: z.boolean(),
    hostVisibleRequirement: z.string(),
    notices: z.boolean(),
    recommendedTemplates: z.array(z.string()),
    contract: z.literal(1),
  })
  .strict();

// ─── The registry ───────────────────────────────────────────────────────────

export interface HostRegistry {
  all(): readonly HostDefinition[];
  get(app: string, entityType: string): HostDefinition | undefined;
}

export interface RegistryOptions {
  readonly production: boolean;
  /** The CRM host's base URL. */
  readonly crmApiUrl: string;
  /** Raw `MEETINGS_TEST_HOSTS` elements, or already-built definitions in tests. Ignored in production. */
  readonly testHosts?: readonly unknown[];
}

export function buildRegistry(options: RegistryOptions): HostRegistry {
  const hosts: HostDefinition[] = [crmDefinition(options.crmApiUrl)];

  if (!options.production) {
    (options.testHosts ?? []).forEach((raw, index) => {
      const parsed = testHostSchema.safeParse(raw);
      // Names the element and the offending member, never a value.
      if (!parsed.success) {
        const where = parsed.error.issues[0]?.path.join(".") || "(element)";
        throw new Error(`MEETINGS_TEST_HOSTS[${index}] is not a valid host definition at ${where}`);
      }
      hosts.push(parsed.data);
    });
  }

  const seen = new Set<string>();
  for (const host of hosts) {
    const key = `${host.app}/${host.entityType}`;
    if (seen.has(key)) throw new Error("two hosts share the same app and entity type");
    seen.add(key);
  }

  return {
    all: () => hosts,
    get: (app, entityType) => hosts.find((h) => h.app === app && h.entityType === entityType),
  };
}

/** Where the CRM lives when CRM_API_URL is unset (development and test only; env.ts requires it in production). */
const LOCAL_CRM_API_URL = "http://localhost:8084";

let current: HostRegistry | null = null;

/** The registry for this process, built once from the environment. */
export function hostRegistry(): HostRegistry {
  current ??= buildRegistry({
    production: env.NODE_ENV === "production",
    crmApiUrl: env.CRM_API_URL ?? LOCAL_CRM_API_URL,
    testHosts: env.MEETINGS_TEST_HOSTS,
  });
  return current;
}

/** Tests only: replace the registry (e.g. with the fake host's definitions), or `null` to rebuild from env. */
export function setRegistryForTests(registry: HostRegistry | null): void {
  current = registry;
}
