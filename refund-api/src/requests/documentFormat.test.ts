/**
 * Unit tests for the refund document's ONE locale (documentFormat.ts).
 *
 * Each of these pins a specific defect the exported PDF actually shipped with:
 * a dot-decimal rate beside comma-decimal amounts, an ISO rate-validity date
 * beside nothing else ISO, currency before the amount where the UI puts it
 * after, and raw ISO timestamps with milliseconds and a UTC Z.
 */

import { describe, it, expect } from "bun:test";
import {
  formatBatchPeriod,
  formatDate,
  formatFilePeriod,
  formatMoney,
  formatPeriod,
  formatRatePerKm,
  formatTimestamp,
} from "./documentFormat";

describe("formatMoney", () => {
  it("puts the currency AFTER the amount, matching refund-ui", () => {
    expect(formatMoney(20650, "CHF")).toBe("206,50 CHF");
    expect(formatMoney(12624, "EUR")).toBe("126,24 €");
  });

  it("uses a comma decimal and always two digits", () => {
    expect(formatMoney(700, "CHF")).toBe("7,00 CHF");
    expect(formatMoney(20605, "CHF")).toBe("206,05 CHF");
  });

  it("rejects a non-integer rather than rendering a wrong amount", () => {
    expect(() => formatMoney(206.5, "CHF")).toThrow(RangeError);
  });
});

describe("formatRatePerKm", () => {
  // The rate arrives as a wire-format decimal STRING with a dot. Printing it
  // verbatim put two number locales on one page.
  it("converts the wire dot-decimal to the document's comma", () => {
    expect(formatRatePerKm("0.70", "CHF")).toBe("0,70 CHF/km");
  });

  it("agrees with formatMoney on where the currency goes", () => {
    expect(formatRatePerKm("0.70", "CHF").endsWith("CHF/km")).toBe(true);
    expect(formatMoney(70, "CHF").endsWith("CHF")).toBe(true);
  });
});

describe("formatDate", () => {
  it("renders a rate's validity like every other date in the document", () => {
    expect(formatDate("2021-01-31")).toBe("31.01.2021");
  });

  it("never parses, so no timezone can shift a date-only value", () => {
    const RealDate = globalThis.Date;
    // @ts-expect-error — deliberately breaking Date to prove it is unused
    globalThis.Date = class {
      constructor() {
        throw new Error("formatDate must not parse a date-only value");
      }
    };
    try {
      expect(formatDate("2026-08-11")).toBe("11.08.2026");
    } finally {
      globalThis.Date = RealDate;
    }
  });
});

describe("formatTimestamp", () => {
  // 2026-09-08T06:45:20.752Z is a log line, not a document.
  it("renders civil time in the document timezone, naming the zone", () => {
    expect(formatTimestamp(new Date("2026-09-08T06:45:20.752Z"))).toBe(
      "08.09.2026 08:45 (CEST)",
    );
  });

  it("follows the summer/winter shift rather than assuming one offset", () => {
    expect(formatTimestamp(new Date("2026-01-15T06:45:00.000Z"))).toBe(
      "15.01.2026 07:45 (CET)",
    );
  });

  it("drops milliseconds and never emits a UTC Z", () => {
    const result = formatTimestamp(new Date("2026-09-08T06:45:20.752Z"));
    expect(result).not.toContain(".752");
    // No ISO date-time shape at all. Checking for a bare "T" would be wrong —
    // "CEST" contains one.
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(result).not.toMatch(/Z$/);
  });

  // The reason the zone is named at all: rendering in UTC moves the DATE for
  // anything stamped late local evening, which on an audit artifact matters.
  it("keeps a late-evening local timestamp on its own local date", () => {
    // 22:30 CEST on 8 Sep is 20:30Z the same day — but 00:30 CEST on 9 Sep
    // is 22:30Z on the 8th, which UTC rendering would file under the wrong day.
    expect(formatTimestamp(new Date("2026-09-08T22:30:00.000Z"))).toBe(
      "09.09.2026 00:30 (CEST)",
    );
  });
});

describe("formatPeriod", () => {
  it("names the month the expenses fall in", () => {
    expect(formatPeriod(["2026-08-11", "2026-08-19", "2026-08-21"])).toBe("August 2026");
  });

  it("spans a range when the lines straddle a month boundary", () => {
    // "August to September 2026" — a dash between two month-years reads as a
    // subtraction on a page full of figures, and the year is stated once.
    expect(formatPeriod(["2026-08-30", "2026-09-02"])).toBe("August to September 2026");
  });

  it("keeps both years when the range crosses one", () => {
    expect(formatPeriod(["2026-12-30", "2027-01-04"])).toBe("December 2026 to January 2027");
  });

  it("is derived from line dates, so filing month never overrides expense month", () => {
    // Filed in September for an August trip — the period is August.
    expect(formatPeriod(["2026-08-11"])).toBe("August 2026");
  });

  it("returns null for a request with no lines rather than inventing a period", () => {
    expect(formatPeriod([])).toBeNull();
  });
});

describe("formatBatchPeriod", () => {
  it("renders a sortable year-month", () => {
    expect(formatBatchPeriod(new Date("2026-09-30T12:00:00.000Z"))).toBe("2026-09");
  });
});

describe("formatFilePeriod", () => {
  // Sortable, unlike formatPeriod's prose: a folder must put August before
  // September, which "August 2026"/"September 2026" does not.
  it("renders a sortable year-month for a filename", () => {
    expect(formatFilePeriod(["2026-08-11", "2026-08-21"])).toBe("2026-08");
  });

  it("takes the earliest month when the lines straddle a boundary", () => {
    expect(formatFilePeriod(["2026-09-02", "2026-08-30"])).toBe("2026-08");
  });

  it("sorts correctly across a year boundary, where prose would not", () => {
    const names = [
      `refund_${formatFilePeriod(["2026-12-02"])}`,
      `refund_${formatFilePeriod(["2027-01-02"])}`,
      `refund_${formatFilePeriod(["2026-08-02"])}`,
    ].sort();
    expect(names).toEqual(["refund_2026-08", "refund_2026-12", "refund_2027-01"]);
  });

  it("returns null with no lines rather than inventing one", () => {
    expect(formatFilePeriod([])).toBeNull();
  });
});
