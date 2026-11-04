/**
 * A fake host for tests (specs/021-meetings plan.md § Host integration contract,
 * "Proved generically by the fake host"). A `Bun.serve` that implements the two
 * endpoints a host owns, over an in-memory entity table:
 *
 *   POST {base}/meeting-host/v1/resolve              (the caller's JWT, forwarded)
 *   POST {base}/system/meeting-host/v1/notices       (a scoped service JWT)
 *
 * It records every notice and every call, and can be told to answer `closed`,
 * `missing`, a given status, a malformed body, or slowly. Two hosts are
 * registered through the SAME HTTP adapter as the CRM (no host-specific code path
 * in meetings-api, AC-11.4):
 *
 *   testhost/widget   notices on,  host-visible offered
 *   quiethost/gadget  notices off, host-visible not offered (its notices route 404s,
 *                     and any attempt to reach it is recorded in `quietNoticeAttempts`)
 */

import type { HostDefinition } from "../hosts/registry";

export interface FakeEntity {
  readonly title: string;
  readonly href: string;
  /** What `hostVisible` answers for a caller who may open it. Default true. */
  readonly hostVisible?: boolean;
  /** `open` (default), or `closed` / `missing` for every caller. */
  readonly state?: "open" | "closed" | "missing";
  /** Per-caller override by JWT `sub`: that caller gets this state instead. */
  readonly stateFor?: Readonly<Record<string, "open" | "closed" | "missing">>;
}

export interface RecordedNotice {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
  /** `false` when the fake saw `seq` at or below the last applied one for that meeting. */
  readonly applied: boolean;
}

export interface RecordedResolve {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: { entityType: string; ids: string[] };
}

/** How the next calls to an endpoint behave. */
export interface Mode {
  /** Answer with this status and an empty problem body. */
  status?: number;
  /** Answer 200 with a body that is not valid for the contract. */
  malformed?: boolean;
  /** Wait this long before answering. */
  delayMs?: number;
}

export interface FakeHost {
  readonly url: string;
  /** The two definitions, ready for a registry: `testhost/widget` and `quiethost/gadget`. */
  readonly definitions: HostDefinition[];
  setEntity(entityType: string, id: string, entity: FakeEntity): void;
  readonly notices: RecordedNotice[];
  readonly resolves: RecordedResolve[];
  /** Notices sent to the host that does not take any. A correct client never produces one. */
  readonly quietNoticeAttempts: unknown[];
  /** Behaviour of `resolve` / `notices` from now on (`{}` restores normal). */
  mode: { resolve: Mode; notices: Mode };
  reset(): void;
  stop(): Promise<void>;
}

const NOTICE_KEYS = ["noticeId", "seq", "event", "meeting", "entity"] as const;
const MEETING_KEYS = ["id", "title", "startsAt", "creatorId"] as const;
const EVENTS = ["linked", "changed", "unlinked", "deleted"];

const labels = (entity: { en: string; it: string }) => ({
  en: { app: "Widgets", entity: entity.en, visibilityHint: "and can see the widget's costs", noticeFailed: "The widget's activity could not be added" },
  it: { app: "Widget", entity: entity.it, visibilityHint: "e possono vedere i costi del widget", noticeFailed: "Non è stato possibile aggiungere l'attività al widget" },
});

function definitions(url: string): HostDefinition[] {
  return [
    {
      app: "testhost",
      entityType: "widget",
      baseUrl: `${url}/testhost`,
      labels: labels({ en: "Widget", it: "Widget" }),
      offersHostVisible: true,
      hostVisibleRequirement: "widget:costs",
      notices: true,
      recommendedTemplates: ["builtin:minutes"],
      contract: 1,
    },
    {
      app: "quiethost",
      entityType: "gadget",
      baseUrl: `${url}/quiethost`,
      labels: labels({ en: "Gadget", it: "Gadget" }),
      offersHostVisible: false,
      hostVisibleRequirement: "",
      notices: false,
      recommendedTemplates: [],
      contract: 1,
    },
  ];
}

/** The `sub` of a Bearer JWT, WITHOUT verifying it (the fake trusts its caller). */
function subOf(authorization: string | null): string | null {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const sub = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function startFakeHost(): FakeHost {
  const entities = new Map<string, FakeEntity>();
  const notices: RecordedNotice[] = [];
  const resolves: RecordedResolve[] = [];
  const quietNoticeAttempts: unknown[] = [];
  const lastSeq = new Map<string, number>();
  const mode: FakeHost["mode"] = { resolve: {}, notices: {} };

  const problem = (status: number, code?: string) =>
    Response.json({ status, ...(code ? { code } : {}) }, { status });

  async function handleResolve(req: Request, path: string): Promise<Response> {
    if (mode.resolve.delayMs) await sleep(mode.resolve.delayMs);
    const authorization = req.headers.get("Authorization");
    const body = (await req.json()) as { entityType: string; ids: string[] };
    resolves.push({ path, authorization, body });
    if (mode.resolve.status) return problem(mode.resolve.status);
    if (mode.resolve.malformed) return Response.json({ items: "nope" });
    if (!authorization) return problem(401);
    const sub = subOf(authorization);
    const items = body.ids.map((id) => {
      const entity = entities.get(`${body.entityType}/${id}`);
      const state = !entity ? "missing" : ((sub && entity.stateFor?.[sub]) || entity.state || "open");
      return state === "open" && entity
        ? { id, state, title: entity.title, href: entity.href, hostVisible: entity.hostVisible ?? true }
        : { id, state };
    });
    return Response.json({ items });
  }

  async function handleNotice(req: Request, path: string): Promise<Response> {
    if (mode.notices.delayMs) await sleep(mode.notices.delayMs);
    const authorization = req.headers.get("Authorization");
    const body = (await req.json()) as Record<string, unknown>;
    if (mode.notices.status) {
      notices.push({ path, authorization, body, applied: false });
      return problem(mode.notices.status);
    }
    if (mode.notices.malformed) return Response.json({ applied: "maybe" });
    if (!authorization) return problem(401);

    // strict body: any other key is a 422 at the host
    const meeting = body["meeting"] as Record<string, unknown> | undefined;
    const entity = body["entity"] as { type?: string; id?: string } | undefined;
    const strict =
      Object.keys(body).every((k) => (NOTICE_KEYS as readonly string[]).includes(k)) &&
      typeof body["noticeId"] === "string" &&
      typeof body["seq"] === "number" &&
      EVENTS.includes(String(body["event"])) &&
      meeting !== undefined &&
      Object.keys(meeting).every((k) => (MEETING_KEYS as readonly string[]).includes(k)) &&
      entity !== undefined &&
      typeof entity.type === "string" &&
      typeof entity.id === "string";
    if (!strict) return problem(422, "invalid_notice");
    if (!entities.has(`${entity!.type}/${entity!.id}`)) return problem(422, "entity_not_found");

    const meetingId = String(meeting!["id"]);
    const seq = body["seq"] as number;
    const applied = seq > (lastSeq.get(meetingId) ?? 0);
    if (applied) lastSeq.set(meetingId, seq);
    notices.push({ path, authorization, body, applied });
    return Response.json({ applied });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST") return problem(405);
      if (path.endsWith("/meeting-host/v1/resolve") && !path.includes("/system/")) return handleResolve(req, path);
      if (path.endsWith("/system/meeting-host/v1/notices")) {
        if (path.startsWith("/quiethost/")) {
          quietNoticeAttempts.push(await req.json().catch(() => null));
          return problem(404);
        }
        return handleNotice(req, path);
      }
      return problem(404);
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    definitions: definitions(url),
    setEntity(entityType, id, entity) {
      entities.set(`${entityType}/${id}`, entity);
    },
    notices,
    resolves,
    quietNoticeAttempts,
    mode,
    reset() {
      entities.clear();
      lastSeq.clear();
      notices.length = 0;
      resolves.length = 0;
      quietNoticeAttempts.length = 0;
      mode.resolve = {};
      mode.notices = {};
    },
    async stop() {
      await server.stop(true);
    },
  };
}
