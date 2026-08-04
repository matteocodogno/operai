/**
 * Unit tests for the pure formatted-address deriver (T2, specs/012-employee-
 * address — refs AC-1.1). No DB, no HTTP — pure function in, string out.
 */

import { describe, expect, test } from "bun:test";
import { formatAddress } from "./address.format";

describe("formatAddress (T2)", () => {
  test("a full address (all six components) renders every segment in order", () => {
    const result = formatAddress(
      {
        countryCode: "CH",
        city: "Zürich",
        street: "Bahnhofstrasse",
        houseNumber: "12b",
        postalCode: "8001",
        region: "Zürich",
      },
      "en",
    );

    expect(result).toBe("Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland");
  });

  test("a minimal four-field address (no postalCode, no region) drops those segments", () => {
    const result = formatAddress(
      {
        countryCode: "FR",
        city: "Paris",
        street: "Rue de Rivoli",
        houseNumber: "1",
      },
      "en",
    );

    expect(result).toBe("Rue de Rivoli 1, Paris, France");
  });

  test("both optional fields explicitly null (not just absent) are dropped identically", () => {
    const result = formatAddress(
      {
        countryCode: "IT",
        city: "Milano",
        street: "Via Roma",
        houseNumber: "5",
        postalCode: null,
        region: null,
      },
      "it",
    );

    // Intl.DisplayNames(['it'], {type:'region'}).of('IT') === 'Italia'
    expect(result).toBe("Via Roma 5, Milano, Italia");
  });

  test("blank-string optional fields are treated as absent (segment dropped)", () => {
    const result = formatAddress(
      {
        countryCode: "CH",
        city: "Bern",
        street: "Marktgasse",
        houseNumber: "2",
        postalCode: "   ",
        region: "",
      },
      "en",
    );

    expect(result).toBe("Marktgasse 2, Bern, Switzerland");
  });

  test("the Intl.DisplayNames-unavailable fallback path emits the raw countryCode, never throws", () => {
    const originalDisplayNames = Intl.DisplayNames;
    // @ts-expect-error — deliberately simulating an ICU build without DisplayNames (R8).
    delete Intl.DisplayNames;

    try {
      expect(() =>
        formatAddress(
          {
            countryCode: "CH",
            city: "Zürich",
            street: "Bahnhofstrasse",
            houseNumber: "12b",
          },
          "en",
        ),
      ).not.toThrow();

      const result = formatAddress(
        {
          countryCode: "CH",
          city: "Zürich",
          street: "Bahnhofstrasse",
          houseNumber: "12b",
        },
        "en",
      );
      expect(result).toBe("Bahnhofstrasse 12b, Zürich, CH");
    } finally {
      // `Intl.DisplayNames` is typed read-only; restoring it after the
      // deliberate `delete` above needs the same escape hatch.
      (Intl as unknown as { DisplayNames: typeof Intl.DisplayNames }).DisplayNames =
        originalDisplayNames;
    }
  });

  test("an unrecognized country code that Intl.DisplayNames cannot resolve falls back to the raw code, never throws", () => {
    // 'ZZ' is not a valid/assigned ISO region — .of() returns undefined for it
    // in most ICU implementations, or in rare cases throws a RangeError.
    // Either way the function must never throw and must fall back cleanly.
    expect(() =>
      formatAddress(
        {
          countryCode: "ZZ",
          city: "Nowhere",
          street: "Nowhere St",
          houseNumber: "1",
        },
        "en",
      ),
    ).not.toThrow();
  });
});
