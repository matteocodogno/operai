/**
 * The single HTTP adapter to hours-api (specs/20261112-meeting-hours plan § Delivering a notice, steps 3 and 4; ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older).
 *
 * meetings-api calls hours-api for exactly one thing, and this module sends it:
 *
 *   sendHoursNotice(channel, notice)
 *       POST {HOURS_API_URL}/system/meeting-hours/v1/notices, a scoped service JWT (`meeting-hours-notices.send`, `sub`
 *       `system:meetings-api`, `aud` = auth's `SERVICE_AUDIENCE`). One attempt (plus the one retry after a 401, below),
 *       5 s timeout. WHEN and how often a failed notice is sent again is the outbox's business (`delivery.ts`), not this
 *       client's.
 *
 * It never throws and never guesses: every outcome is a typed result.
 *
 *   200 { applied }          delivered (`applied: false` = hours-api already held a newer version; nothing to do)
 *   400, 422                 failed for good: the body itself is refused. Sending it again cannot help.
 *   401                      the token is forgotten and the call repeated ONCE with a fresh one; a second 401 is failed for
 *                            now (`unauthorized`): an operator has to fix the client or the allowlist
 *   anything else            failed for now: 403, 404 (hours-api not deployed with the route yet), 409, 429, 5xx, a timeout,
 *                            a transport error, a token that could not be had, an answer that is not the contract's
 *
 * Failure codes are CLOSED: an HTTP status (`http_503`), or one of a few words. Never a message, never a body: an error
 * message can carry what was sent.
 *
 * Logging: this module logs nothing. The delivery logs the meeting id and the closed code, and never a user id, a token
 * or a body (AC-4.1; specs/20261104-meetings AC-4.10; no user id: this plan § Security).
 *
 * A request carries the bearer token, so it NEVER follows a redirect (`redirect: "error"`): a redirect would replay the
 * credential to another host.
 */

import { z } from "zod";
import { env } from "../lib/env";
import type { MeetingHoursNotice } from "../lib/meetingHoursWire";
import { serviceTokens, type ServiceTokenProvider } from "../lib/serviceToken";

const NOTICE_TIMEOUT_MS = 5_000;
const NOTICE_PATH = "/system/meeting-hours/v1/notices";

// ─── The channel ─────────────────────────────────────────────────────────────

/** Where the notices go and the credential they carry. */
export interface HoursChannel {
  readonly baseUrl: string;
  readonly tokens: ServiceTokenProvider;
}

let testChannel: HoursChannel | null | undefined;

/** Tests only: `undefined` restores the environment's channel, `null` switches the channel off, a value replaces it. */
export function setHoursChannelForTests(channel: HoursChannel | null | undefined): void {
  testChannel = channel;
}

/**
 * The hours channel is ENABLED iff `HOURS_API_URL` resolves and the service credential is configured (plan § Delivering a
 * notice). `null` otherwise: nothing is recorded for hours-api and a job that finds it off marks its row `failed`
 * `disabled`.
 */
export function resolveHoursChannel(baseUrl: string | undefined, tokens: ServiceTokenProvider | null): HoursChannel | null {
  return baseUrl && tokens ? { baseUrl, tokens } : null;
}

/**
 * The channel of this process: what a test set, else the environment's. Under `NODE_ENV=test` the environment's is never
 * used (as the notifier's, `src/lib/notify.ts`): a developer's machine can hold real credentials in its environment files, and
 * a test must not reach a real hours-api with them by accident. A test that wants a channel sets one (a fake hours-api), and
 * otherwise has none.
 */
export function hoursChannel(): HoursChannel | null {
  if (testChannel !== undefined) return testChannel;
  if (env.NODE_ENV === "test") return null;
  return resolveHoursChannel(env.HOURS_API_URL, serviceTokens);
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** A closed vocabulary: an HTTP status or a word, never a message or a body. */
export type HoursNoticeFailureCode =
  | "invalid_request"
  | "rejected"
  | "unauthorized"
  | "timeout"
  | "transport"
  | "token_unavailable"
  | "malformed"
  | `http_${number}`;

export type HoursNoticeResult =
  | { readonly state: "delivered"; readonly applied: boolean }
  | { readonly state: "failed"; readonly permanent: boolean; readonly code: HoursNoticeFailureCode };

const failed = (code: HoursNoticeFailureCode, permanent: boolean): HoursNoticeResult => ({ state: "failed", permanent, code });

const answer = z.object({ applied: z.boolean() });

export interface HoursClientOptions {
  /** Overrides the 5 s timeout (tests). */
  readonly timeoutMs?: number;
}

// ─── sendHoursNotice ─────────────────────────────────────────────────────────

export async function sendHoursNotice(
  channel: HoursChannel,
  notice: MeetingHoursNotice,
  options: HoursClientOptions = {},
): Promise<HoursNoticeResult> {
  const url = `${channel.baseUrl.replace(/\/+$/, "")}${NOTICE_PATH}`;
  const body = JSON.stringify(notice);
  const timeoutMs = options.timeoutMs ?? NOTICE_TIMEOUT_MS;

  try {
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await channel.tokens.getToken();
      } catch {
        // Our own ServiceTokenError (a status only) or the runtime's: neither is worth more than "could not get one".
        return failed("token_unavailable", false);
      }

      const res = await globalThis.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        // The bearer token travels with this request: never let a redirect carry it elsewhere.
        redirect: "error",
      });

      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        if (attempt === 0) {
          channel.tokens.invalidate(token);
          continue;
        }
        return failed("unauthorized", false);
      }

      if (res.ok) {
        const parsed = answer.safeParse(await res.json().catch(() => null));
        // Not the contract's answer: it may be a proxy or another service, so the notice stays owed.
        return parsed.success ? { state: "delivered", applied: parsed.data.applied } : failed("malformed", false);
      }

      await res.body?.cancel().catch(() => {});
      if (res.status === 400) return failed("invalid_request", true);
      if (res.status === 422) return failed("rejected", true);
      return failed(`http_${res.status}`, false);
    }
  } catch (error) {
    return failed(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport", false);
  }
}
