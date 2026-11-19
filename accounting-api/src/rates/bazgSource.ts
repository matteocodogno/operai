/**
 * The outbound client for the federal monthly average rates (T9,
 * specs/20261118-refund-accounting-export; AC-5.1, AC-5.6; ADR
 * 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-
 * ...-and-the-outbound-fetch-is-hardened; plan "FX source rules"; security
 * surface 3).
 *
 * The one outbound call this service makes whose answer comes from outside
 * the suite, so it is deliberately narrow:
 *
 * - ONE constant host over https. The URL is built from a validated `YYYY-MM`
 *   and nothing else: no configuration, no user input, no scheme or host that
 *   can be changed (SSRF guard).
 * - `redirect: "error"`: a 3xx is a failure, never followed.
 * - 5 s per call, and the caller's own signal (the whole-trigger budget) on top.
 * - The body is read as a STREAM and cut off at 512 KiB, so a hostile or broken
 *   answer cannot fill memory. `Content-Length` is checked first as a shortcut.
 * - Failures are data (`{ ok: false, code }`), never exceptions, and never carry
 *   the response body. The codes are the attempt-log ones.
 *
 * The fetcher is injectable: tests and the fake source never touch the network.
 */

import { isMonthKey } from "./months";

/**
 * The only host this module ever contacts: the BAZG's rates backend. It serves the monthly average rates for VAT
 * that the Federal Tax Administration (AFC/ESTV) publishes: the AFC/ESTV is the AUTHORITY for the rates, and
 * this endpoint is the "XML-File" link of its "Aktueller Monatsmittelkurs MWST" page (SO-21,
 * specs/20261119-accounting; the BAZG provides them "unverbindlich", without obligation). The internal id
 * `bazg` names this channel, not the authority. An opt-in live test (`afc.live.test.ts`,
 * `ACCOUNTING_LIVE_RATES=1`) checks 2026-03 = EUR 0.9246 against it.
 */
export const BAZG_HOST = "www.backend-rates.bazg.admin.ch";
export const BAZG_PATH = "/api/xmlavgmonth";
export const FX_CALL_TIMEOUT_MS = 5_000;
export const FX_MAX_BODY_BYTES = 512 * 1024;

/** The slice of `fetch` this client uses; `globalThis.fetch` satisfies it. */
export type FxFetcher = (
  url: string,
  init: { readonly signal: AbortSignal; readonly redirect: "error"; readonly headers: Record<string, string> },
) => Promise<Response>;

export type BazgFetchResult =
  | { readonly ok: true; readonly url: string; readonly body: string }
  | {
      readonly ok: false;
      readonly url: string;
      /** `timeout` | `http_<status>` | `network` | `too_large` */
      readonly code: string;
    };

/** `https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03` for `2026-03`. */
export function bazgUrl(month: string): string {
  if (!isMonthKey(month)) throw new RangeError(`month must be YYYY-MM, got ${JSON.stringify(month)}`);
  return `https://${BAZG_HOST}${BAZG_PATH}?j=${month.slice(0, 4)}&m=${month.slice(5, 7)}`;
}

export interface BazgFetchOptions {
  readonly fetcher?: FxFetcher;
  /** The caller's budget or cancellation; combined with the per-call timeout. */
  readonly signal?: AbortSignal;
  readonly callTimeoutMs?: number;
  readonly maxBytes?: number;
}

export async function fetchBazgMonth(month: string, options: BazgFetchOptions = {}): Promise<BazgFetchResult> {
  const url = bazgUrl(month);
  const fetcher: FxFetcher = options.fetcher ?? ((u, init) => fetch(u, init));
  const maxBytes = options.maxBytes ?? FX_MAX_BODY_BYTES;
  const timeout = AbortSignal.timeout(options.callTimeoutMs ?? FX_CALL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const aborted = (): boolean => signal.aborted;

  try {
    const response = await fetcher(url, {
      signal,
      redirect: "error",
      headers: { Accept: "application/xml, text/xml" },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, url, code: `http_${response.status}` };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, url, code: "too_large" };
    }
    const body = await readCapped(response, maxBytes);
    return body === null ? { ok: false, url, code: "too_large" } : { ok: true, url, body };
  } catch {
    // AbortError (the per-call timeout or the budget), a refused redirect, DNS, TLS, a reset
    // connection: the reason is not worth more than a code, and the message could carry a URL.
    return { ok: false, url, code: aborted() ? "timeout" : "network" };
  }
}

/** The body as text, or `null` when it is longer than `maxBytes`. Stops reading at the limit. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}
