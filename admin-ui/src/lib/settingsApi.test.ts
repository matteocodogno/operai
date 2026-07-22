/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/settingsApi.ts — typed API client for refund-api's
 * refund-settings management surface (T6, specs/011-refund-settings/tasks.md).
 *
 * Strategy mirrors ratesApi.test.ts exactly:
 *   • `shell/session`'s `apiFetch` is mocked at the module level so tests
 *     control the raw Response objects and inspect exactly what was sent.
 *   • `getRefundApiBaseUrl` is mocked too, proving the base URL comes from
 *     the SHELL — never admin-ui's own `import.meta.env`.
 *   • Every operation is checked for: (a) correct HTTP method + URL built
 *     against the shell-provided base, (b) correct JSON request body (where
 *     applicable), (c) a successful response parsed to the typed shape, (d) a
 *     non-2xx response mapped to `ApiError` with the right status/detail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("shell/session", () => ({
  apiFetch: vi.fn(),
  getRefundApiBaseUrl: vi.fn(),
}));

import { apiFetch, getRefundApiBaseUrl } from "shell/session";
import {
  ACCOUNTING_DISTRIBUTION_EMAIL_KEY,
  ApiError,
  getSetting,
  putSetting,
} from "./settingsApi";
import type { ApiProblem, SettingResult } from "./settingsApi";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFUND_API_URL = "http://refund-api.test";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const configuredResult: SettingResult = {
  key: ACCOUNTING_DISTRIBUTION_EMAIL_KEY,
  value: "accounting@welld.ch",
  configured: true,
  updatedAt: "2026-07-20T09:12:00.000Z",
  updatedByEmail: "admin@welld.ch",
  history: [
    {
      value: "accounting@welld.ch",
      changedAt: "2026-07-20T09:12:00.000Z",
      changedByEmail: "admin@welld.ch",
    },
  ],
};

const notConfiguredResult: SettingResult = {
  key: ACCOUNTING_DISTRIBUTION_EMAIL_KEY,
  value: null,
  configured: false,
  updatedAt: null,
  updatedByEmail: null,
  history: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const okResponse = (body: unknown): Response => makeResponse(200, body);

const problemResponse = (
  status: number,
  title: string,
  detail?: string,
  instance?: string,
): Response =>
  makeResponse(status, {
    type: `https://httpstatuses.com/${status}`,
    title,
    status,
    detail,
    instance,
  } satisfies ApiProblem);

const lastCall = (): { url: string; init: RequestInit | undefined } => {
  const mockFn = vi.mocked(apiFetch);
  const calls = mockFn.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [input, init] = calls[calls.length - 1];
  return { url: String(input), init };
};

const expectApiError = async (
  fn: () => Promise<unknown>,
  status: number,
): Promise<ApiError> => {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  expect((thrown as ApiError).status).toBe(status);
  return thrown as ApiError;
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(getRefundApiBaseUrl).mockReturnValue(REFUND_API_URL);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Base URL wiring
// ---------------------------------------------------------------------------

describe("base URL wiring", () => {
  it("getSetting() builds its request URL from getRefundApiBaseUrl(), not import.meta.env", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(configuredResult));

    await getSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY);

    expect(getRefundApiBaseUrl).toHaveBeenCalled();
    const { url } = lastCall();
    expect(url).toBe(
      `${REFUND_API_URL}/settings/${ACCOUNTING_DISTRIBUTION_EMAIL_KEY}`,
    );
  });

  it("every call goes through the shared shell/session apiFetch (Bearer + trusted-origin machinery)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(configuredResult));

    await getSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY);

    expect(apiFetch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getSetting()
// ---------------------------------------------------------------------------

describe("getSetting()", () => {
  it("issues GET /settings/:key and returns the current value + history (AC-1.1, AC-5.3)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(configuredResult));

    const result = await getSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY);

    const { url, init } = lastCall();
    expect(url).toBe(
      `${REFUND_API_URL}/settings/${ACCOUNTING_DISTRIBUTION_EMAIL_KEY}`,
    );
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(result).toEqual(configuredResult);
  });

  it("returns configured:false and a null value when the setting has never been set", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(notConfiguredResult));

    const result = await getSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY);

    expect(result.configured).toBe(false);
    expect(result.value).toBeNull();
  });

  it("throws ApiError on 403 (missing settings:read, AC-3.1)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(403, "Forbidden", "Missing capability: settings:read"),
    );

    const err = await expectApiError(
      () => getSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY),
      403,
    );
    expect(err.detail).toBe("Missing capability: settings:read");
  });

  it("throws ApiError on 404 (unknown key)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(404, "Not Found", "Unknown setting key"),
    );

    await expectApiError(() => getSetting("not-a-real-key"), 404);
  });

  it("throws ApiError on 401 (no session)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(401, "Unauthorized"),
    );
    await expectApiError(
      () => getSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY),
      401,
    );
  });
});

// ---------------------------------------------------------------------------
// putSetting()
// ---------------------------------------------------------------------------

describe("putSetting()", () => {
  it("issues PUT /settings/:key with { value } and returns the post-write state (AC-1.2)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(configuredResult));

    const result = await putSetting(
      ACCOUNTING_DISTRIBUTION_EMAIL_KEY,
      "accounting@welld.ch",
    );

    const { url, init } = lastCall();
    expect(url).toBe(
      `${REFUND_API_URL}/settings/${ACCOUNTING_DISTRIBUTION_EMAIL_KEY}`,
    );
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      value: "accounting@welld.ch",
    });
    expect(result).toEqual(configuredResult);
  });

  it("sends { value: null } to clear the setting (AC-1.4)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(notConfiguredResult));

    const result = await putSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, null);

    const { init } = lastCall();
    expect(JSON.parse(init?.body as string)).toEqual({ value: null });
    expect(result.configured).toBe(false);
  });

  it("throws ApiError on 422 for a malformed email (AC-1.3)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(
        422,
        "Unprocessable Entity",
        "value must be a well-formed email address",
      ),
    );

    const err = await expectApiError(
      () => putSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, "not-an-email"),
      422,
    );
    expect(err.detail).toBe("value must be a well-formed email address");
  });

  it("throws ApiError on 403 (missing settings:manage, AC-3.1)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(403, "Forbidden", "Missing capability: settings:manage"),
    );
    await expectApiError(
      () =>
        putSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, "accounting@welld.ch"),
      403,
    );
  });

  it("throws ApiError on 404 (unknown key)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(404, "Not Found", "Unknown setting key"),
    );
    await expectApiError(
      () => putSetting("not-a-real-key", "accounting@welld.ch"),
      404,
    );
  });

  it("throws ApiError on 401 (no session)", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      problemResponse(401, "Unauthorized"),
    );
    await expectApiError(
      () =>
        putSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, "accounting@welld.ch"),
      401,
    );
  });

  it("a non-Problem-JSON error body still produces an ApiError from the raw status", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    const err = await expectApiError(
      () =>
        putSetting(ACCOUNTING_DISTRIBUTION_EMAIL_KEY, "accounting@welld.ch"),
      500,
    );
    expect(err.title).toBe("Internal Server Error");
  });
});
