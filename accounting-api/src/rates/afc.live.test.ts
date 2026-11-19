/**
 * OPT-IN live check of the AFC/ESTV's XML channel (T65, specs/20261119-accounting; AC-2.1, AC-2.12; plan
 * "Accounting sign-off delta" SO-21).
 *
 * The Federal Tax Administration (AFC/ESTV) names the monthly average rate it publishes for VAT; its "XML-File"
 * link is the endpoint this service reads, served by the BAZG (`bazgSource.ts`). This test fetches 2026-03 from
 * that real endpoint and expects the value accounting confirmed: EUR 0.9246 (924600 micros).
 *
 * It is SKIPPED unless `ACCOUNTING_LIVE_RATES=1` is set, exactly that value. It makes a real outbound call, so it
 * never runs in the default suite or in CI, and nobody should set the flag there. QE runs it once per release on
 * a networked machine:
 *
 *   ACCOUNTING_LIVE_RATES=1 bun test src/rates/afc.live.test.ts
 *
 * Environment: it needs no database and no service configuration (only `fetchBazgMonth` and `parseBazgMonth`).
 */

import { describe, expect, it } from "bun:test";
import { fetchBazgMonth } from "./bazgSource";
import { parseBazgMonth } from "./parse";

/** The month accounting confirmed against the AFC's published value (AC-2.12). */
const LIVE_MONTH = "2026-03";
const LIVE_EUR_MICROS = 924_600;

const live = process.env.ACCOUNTING_LIVE_RATES === "1";

describe.skipIf(!live)("AFC/ESTV XML channel (live, opt-in: ACCOUNTING_LIVE_RATES=1)", () => {
  it(
    `answers EUR 0.9246 for ${LIVE_MONTH}`,
    async () => {
      const fetched = await fetchBazgMonth(LIVE_MONTH);
      expect(fetched).toMatchObject({ ok: true });
      if (!fetched.ok) return;

      const parsed = parseBazgMonth(fetched.body, LIVE_MONTH);
      expect(parsed).toMatchObject({ ok: true, month: LIVE_MONTH });
      if (!parsed.ok) return;
      expect(parsed.rates.EUR).toBe(LIVE_EUR_MICROS);
    },
    30_000,
  );
});
