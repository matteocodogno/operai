/**
 * A fake BAZG source for the rates tests (T10, specs/20261119-accounting): the helpers `fx.service.test.ts` of
 * refund-api wrote inline, extracted so the service tests, the route tests (T12) and the system tests (T13) share
 * one. No test touches the network: the client's `fetcher` is injected (`bazgSource.ts`).
 *
 *   const { fetcher, urls } = fakeSource();                 // every month answers the documented 0.9246 / 0.7808 / 1.0635
 *   const { fetcher } = fakeSource((month) => new Response(xmlFor(month, "0.9500")));
 *   const svc = createRatesService({ fetcher, ... });
 *
 * `xmlFor` is the minimal document the strict parser accepts, in the source's own shape; the recorded real answer for
 * 2026-03 is `recordedMarch2026Xml()`.
 */

import { readFileSync } from "node:fs";
import type { FxFetcher } from "../rates/bazgSource";

/** A document for `month` the parser accepts: EUR, USD and GBP at the given rates, each per 1 unit. */
export function xmlFor(month: string, eur = "0.9246", usd = "0.7808", gbp = "1.0635"): string {
  return `<?xml version="1.0"?><monatsmittelkurs><monat>${month}</monat>
    <devise code="eur"><waehrung>1 EUR</waehrung><kurs>${eur}</kurs></devise>
    <devise code="usd"><waehrung>1 USD</waehrung><kurs>${usd}</kurs></devise>
    <devise code="gbp"><waehrung>1 GBP</waehrung><kurs>${gbp}</kurs></devise></monatsmittelkurs>`;
}

/** The recorded real answer of the federal source for 2026-03 (146 currencies): EUR 0.9246, USD 0.7808, GBP 1.0635. */
export function recordedMarch2026Xml(): string {
  return readFileSync(new URL("../rates/fixtures/bazg-xmlavgmonth-2026-03.xml", import.meta.url), "utf8");
}

/** The `YYYY-MM` a source URL asks for (`...?j=2026&m=03`). */
export function monthOfUrl(url: string): string {
  return `${/j=(\d{4})/.exec(url)![1]}-${/m=(\d{2})/.exec(url)![1]}`;
}

/** What a fake answers for a month; a promise lets a test make the answer slow. */
export type FakeAnswer = (month: string) => Response | Promise<Response>;

/**
 * A fake source that answers each requested month from `answer` (the default is `xmlFor`'s document), refuses a call
 * whose signal has already fired, and records the URLs it was asked, in order.
 */
export function fakeSource(answer: FakeAnswer = (month) => new Response(xmlFor(month))) {
  const urls: string[] = [];
  const fetcher: FxFetcher = async (url, init) => {
    urls.push(url);
    if (init.signal.aborted) throw new Error("aborted");
    return answer(monthOfUrl(url));
  };
  return { fetcher, urls };
}

/** A source that never answers: the promise ends only when the caller's signal fires (the per-call timeout or the budget). */
export const hangingFetcher: FxFetcher = (_url, init) =>
  new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
