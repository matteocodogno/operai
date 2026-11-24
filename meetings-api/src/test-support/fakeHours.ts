/**
 * A fake hours-api for tests (specs/20261112-meeting-hours plan § Delivering a notice, § hours-api
 * `POST /system/meeting-hours/v1/notices`). A `Bun.serve` on an ephemeral port that the test opens and closes itself,
 * implementing the one route meetings-api calls:
 *
 *   POST {base}/system/meeting-hours/v1/notices     (a scoped service JWT, here only: any Bearer)
 *
 * It records every request, and it answers the way the real route does: no `Authorization` is a 401, a body that the
 * SHARED wire schema (`src/lib/meetingHoursWire.ts`, the very file hours-api parses with) refuses is a 400
 * `invalid_request`, and otherwise `200 { applied }`, where `applied` is false for a version older than the newest it
 * holds for that meeting (an equal one is applied again). So a test proves the body is one hours-api accepts, not one
 * the test happens to like.
 *
 * `enqueue` scripts the next answers (a 503 then a 200, a slow one, a redirect, a body that is not the contract's), each
 * used once, in order; when none is left the real behaviour above answers.
 */

import { meetingHoursNoticeWire, type MeetingHoursNotice } from "../lib/meetingHoursWire";

export interface ReceivedHoursNotice {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  /** The JSON body as sent (`undefined` when it was not JSON). */
  readonly body: unknown;
  /** The same body, when the shared wire schema accepts it. */
  readonly notice: MeetingHoursNotice | null;
}

/** One scripted answer. */
export interface Answer {
  /** Status to answer with (default 200). A non-2xx answers an empty problem body. */
  readonly status?: number;
  /** JSON body of the answer (default `{ applied: true }` for a 2xx). */
  readonly body?: unknown;
  /** Wait this long before answering. */
  readonly delayMs?: number;
  /** Answer 302 to this location instead. */
  readonly redirectTo?: string;
  /** Answer 200 with a body that is not JSON. */
  readonly notJson?: boolean;
}

export interface FakeHours {
  readonly url: string;
  readonly received: ReceivedHoursNotice[];
  /** The notices that were accepted (200 with the real behaviour), in order. */
  readonly accepted: MeetingHoursNotice[];
  /** Script the next answers, one per request, in order. */
  enqueue(...answers: Answer[]): void;
  /** The newest `seq` the fake has applied for a meeting (what the real route keeps), or 0. */
  appliedSeq(meetingId: string): number;
  reset(): void;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const problem = (status: number, code?: string) => Response.json({ status, ...(code ? { code } : {}) }, { status });

export function startFakeHours(): FakeHours {
  const received: ReceivedHoursNotice[] = [];
  const accepted: MeetingHoursNotice[] = [];
  const script: Answer[] = [];
  const applied = new Map<string, number>();

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const authorization = req.headers.get("Authorization");
    const text = await req.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const parsed = meetingHoursNoticeWire.safeParse(body);
    received.push({
      path,
      method: req.method,
      authorization,
      contentType: req.headers.get("Content-Type"),
      body,
      notice: parsed.success ? parsed.data : null,
    });

    const scripted = script.shift();
    if (scripted) {
      if (scripted.delayMs) await sleep(scripted.delayMs);
      if (scripted.redirectTo) return new Response(null, { status: 302, headers: { Location: scripted.redirectTo } });
      if (scripted.notJson) return new Response("<html>not the contract</html>", { status: scripted.status ?? 200 });
      const status = scripted.status ?? 200;
      if (status >= 200 && status < 300) return Response.json(scripted.body ?? { applied: true }, { status });
      return scripted.body !== undefined ? Response.json(scripted.body, { status }) : problem(status);
    }

    if (req.method !== "POST" || path !== "/system/meeting-hours/v1/notices") return problem(404);
    if (!authorization?.startsWith("Bearer ")) return problem(401);
    if (!parsed.success) return problem(400, "invalid_request");

    const { id, seq } = parsed.data.meeting;
    const held = applied.get(id) ?? 0;
    // Older than the newest applied: nothing changes. Equal is applied again (idempotent).
    if (seq < held) return Response.json({ applied: false });
    applied.set(id, seq);
    accepted.push(parsed.data);
    return Response.json({ applied: true });
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });

  return {
    url: `http://127.0.0.1:${server.port}`,
    received,
    accepted,
    enqueue: (...answers) => void script.push(...answers),
    appliedSeq: (meetingId) => applied.get(meetingId) ?? 0,
    reset() {
      received.length = 0;
      accepted.length = 0;
      script.length = 0;
      applied.clear();
    },
    async stop() {
      await server.stop(true);
    },
  };
}
