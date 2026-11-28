import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ServiceTokenError, type ServiceTokenProvider } from "../lib/serviceToken";
import type { MeetingHoursNotice } from "../lib/meetingHoursWire";
import { startFakeHours, type FakeHours } from "../test-support/fakeHours";
import { hoursChannel, resolveHoursChannel, sendHoursNotice, setHoursChannelForTests, type HoursChannel } from "./client";

// The one HTTP adapter to hours-api (specs/20261112-meeting-hours T8; plan § Delivering a notice, steps 3 and 4):
// `POST {HOURS_API_URL}/system/meeting-hours/v1/notices`, a scoped service JWT, 5 s, no redirect, one retry after a 401
// with the token invalidated, and a typed outcome (never a throw): delivered, failed for good (400, 422) or failed
// for now (anything else). A fake hours-api on an ephemeral port answers as the real route does.

let fake: FakeHours;
let warnings: string[];
let spies: ReturnType<typeof spyOn>[];

beforeEach(() => {
  fake = startFakeHours();
  warnings = [];
  const capture = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  spies = [spyOn(console, "log").mockImplementation(capture), spyOn(console, "warn").mockImplementation(capture), spyOn(console, "error").mockImplementation(capture)];
});
afterEach(async () => {
  spies.forEach((s) => s.mockRestore());
  await fake.stop();
});

/** A token provider that hands out tok-1, tok-2, … and remembers what it was told to forget. */
function tokens(failWith?: Error): ServiceTokenProvider & { readonly issued: string[]; readonly invalidated: string[] } {
  const issued: string[] = [];
  const invalidated: string[] = [];
  let current: string | null = null;
  return {
    issued,
    invalidated,
    async getToken() {
      if (failWith) throw failWith;
      if (current === null) {
        current = `tok-${issued.length + 1}`;
        issued.push(current);
      }
      return current;
    },
    invalidate(token) {
      invalidated.push(token);
      if (current === token) current = null;
    },
  };
}

const channel = (t: ServiceTokenProvider = tokens(), baseUrl = fake.url): HoursChannel => ({ baseUrl, tokens: t });

const notice = (over: Partial<MeetingHoursNotice["meeting"]> = {}): MeetingHoursNotice => ({
  noticeId: "notice-1",
  meeting: {
    id: "meeting-1",
    seq: 3,
    facts: {
      startsAt: "2026-11-24T09:00:00.000Z",
      durationMs: 1_800_000,
      creatorId: "creator-1",
      participantIds: ["user-secret-1", "user-secret-2"],
    },
    ...over,
  },
});

describe("the channel (plan § Delivering a notice: enabled iff HOURS_API_URL resolves AND the service credential is configured)", () => {
  it("is enabled with both, and off when either is missing", () => {
    const t = tokens();
    expect(resolveHoursChannel("http://hours-api.railway.internal:8090", t)).toEqual({ baseUrl: "http://hours-api.railway.internal:8090", tokens: t });
    expect(resolveHoursChannel(undefined, t)).toBeNull();
    expect(resolveHoursChannel("", t)).toBeNull();
    expect(resolveHoursChannel("http://localhost:8090", null)).toBeNull();
  });

  it("is off under NODE_ENV=test whatever the environment holds (a test never reaches a real hours-api by accident), unless a test sets one", () => {
    setHoursChannelForTests(undefined);
    expect(hoursChannel()).toBeNull();
    const own = channel();
    setHoursChannelForTests(own);
    expect(hoursChannel()).toBe(own);
    setHoursChannelForTests(null);
    expect(hoursChannel()).toBeNull();
    setHoursChannelForTests(undefined);
  });
});

describe("the request", () => {
  it("POSTs the notice as JSON to /system/meeting-hours/v1/notices with the service token, and reads { applied }", async () => {
    const result = await sendHoursNotice(channel(), notice());

    expect(result).toEqual({ state: "delivered", applied: true });
    expect(fake.received).toHaveLength(1);
    const req = fake.received[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/system/meeting-hours/v1/notices");
    expect(req.authorization).toBe("Bearer tok-1");
    expect(req.contentType).toContain("application/json");
    expect(req.body).toEqual(notice());
    expect(req.notice).not.toBeNull();
  });

  it("sends a facts-null notice (the meeting is gone) as it is", async () => {
    const gone = notice({ facts: null });
    expect(await sendHoursNotice(channel(), gone)).toEqual({ state: "delivered", applied: true });
    expect(fake.received[0]!.body).toEqual(gone);
  });

  it("passes an older-version answer through: applied false is delivered all the same", async () => {
    fake.enqueue({ body: { applied: false } });
    expect(await sendHoursNotice(channel(), notice())).toEqual({ state: "delivered", applied: false });
  });

  it("does not double the slash when the base URL ends with one", async () => {
    await sendHoursNotice(channel(tokens(), `${fake.url}/`), notice());
    expect(fake.received[0]!.path).toBe("/system/meeting-hours/v1/notices");
  });
});

describe("failed for good: the body itself is refused", () => {
  it("400 is permanent, code invalid_request, and is not retried", async () => {
    fake.enqueue({ status: 400, body: { status: 400, code: "invalid_request", field: "meeting.seq" } });
    expect(await sendHoursNotice(channel(), notice())).toEqual({ state: "failed", permanent: true, code: "invalid_request" });
    expect(fake.received).toHaveLength(1);
  });

  it("422 is permanent, code rejected", async () => {
    fake.enqueue({ status: 422 });
    expect(await sendHoursNotice(channel(), notice())).toEqual({ state: "failed", permanent: true, code: "rejected" });
    expect(fake.received).toHaveLength(1);
  });
});

describe("failed for now: anything an operator or time can fix", () => {
  for (const status of [403, 404, 409, 429, 500, 502, 503]) {
    it(`${status} is transient, with the status as its code`, async () => {
      fake.enqueue({ status });
      expect(await sendHoursNotice(channel(), notice())).toEqual({ state: "failed", permanent: false, code: `http_${status}` });
      expect(fake.received).toHaveLength(1);
    });
  }

  it("a 401 invalidates the token and retries ONCE with a fresh one: delivered when that is accepted", async () => {
    const t = tokens();
    fake.enqueue({ status: 401 });
    expect(await sendHoursNotice(channel(t), notice())).toEqual({ state: "delivered", applied: true });
    expect(t.invalidated).toEqual(["tok-1"]);
    expect(fake.received.map((r) => r.authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("a 401 after the retry is transient, code unauthorized, and there is no third attempt", async () => {
    const t = tokens();
    fake.enqueue({ status: 401 }, { status: 401 }, { status: 401 });
    expect(await sendHoursNotice(channel(t), notice())).toEqual({ state: "failed", permanent: false, code: "unauthorized" });
    expect(fake.received).toHaveLength(2);
    expect(t.invalidated).toEqual(["tok-1"]);
  });

  it("a timeout is transient", async () => {
    fake.enqueue({ delayMs: 400 });
    expect(await sendHoursNotice(channel(), notice(), { timeoutMs: 50 })).toEqual({ state: "failed", permanent: false, code: "timeout" });
  });

  it("a server that is not there (connection refused) is transient: transport", async () => {
    await fake.stop();
    expect(await sendHoursNotice(channel(), notice(), { timeoutMs: 500 })).toEqual({ state: "failed", permanent: false, code: "transport" });
    fake = startFakeHours(); // afterEach stops one
  });

  it("never follows a redirect (the bearer token must not travel on): transport, and the target is never called", async () => {
    fake.enqueue({ redirectTo: `${fake.url}/elsewhere` });
    expect(await sendHoursNotice(channel(), notice())).toEqual({ state: "failed", permanent: false, code: "transport" });
    expect(fake.received).toHaveLength(1);
  });

  it("an answer that is not the contract's { applied } is transient (it may be a proxy, not hours-api): malformed", async () => {
    fake.enqueue({ notJson: true });
    expect(await sendHoursNotice(channel(), notice())).toEqual({ state: "failed", permanent: false, code: "malformed" });
    fake.enqueue({ body: { applied: "maybe" } });
    expect(await sendHoursNotice(channel(), notice())).toEqual({ state: "failed", permanent: false, code: "malformed" });
  });

  it("a token that cannot be got is transient, token_unavailable, and nothing is sent", async () => {
    const result = await sendHoursNotice(channel(tokens(new ServiceTokenError("auth /system/service-token responded with HTTP 503"))), notice());
    expect(result).toEqual({ state: "failed", permanent: false, code: "token_unavailable" });
    expect(fake.received).toHaveLength(0);
  });
});

describe("what is never written to a log (AC-4.1, AC-4.10: identifiers only, and not even those here)", () => {
  it("a failure logs no token, no user id, no body", async () => {
    fake.enqueue({ status: 503 }, { status: 401 }, { status: 401 });
    await sendHoursNotice(channel(), notice());
    await sendHoursNotice(channel(), notice());
    await sendHoursNotice(channel(tokens(new ServiceTokenError("secret-token-detail"))), notice());
    const logged = warnings.join("\n");
    for (const forbidden of ["tok-", "Bearer", "user-secret-1", "user-secret-2", "creator-1", "secret-token-detail", "2026-11-24"]) {
      expect(logged).not.toContain(forbidden);
    }
  });
});
