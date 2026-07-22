/**
 * The settings descriptor registry (T3, specs/011-refund-settings, plan.md §
 * Architecture — "a small settings descriptor registry maps each `key` →
 * `{ label, validate }` so the store *and* the route stay extensible").
 *
 * This is the SINGLE seam a future refund setting extends through (R5,
 * plan.md § Risks): add an entry here, and `routes.ts` automatically gains a
 * working `GET`/`PUT /settings/:newKey}` pair — no route-layer change
 * needed. A `key` NOT present here is a `404` on both routes (AC unknown key
 * — never silently accepted, never a 500 from an unregistered write path).
 *
 * `validate` returns `null` when `value` is acceptable, or a human-readable
 * error message otherwise (surfaced verbatim in the 422 Problem `detail`,
 * AC-1.3). It is only ever called with a NON-null value — clearing (`null`,
 * normalized from `""`) is a distinct, always-valid transition (AC-1.4) that
 * bypasses `validate` entirely (settings/service.ts).
 */

import { z } from "zod";

export interface SettingDescriptor {
  readonly key: string;
  readonly label: string;
  /** Returns an error message if `value` is not acceptable, `null` if it is. Never called with `null` (clearing is always valid). */
  readonly validate: (value: string) => string | null;
}

const EmailShapeSchema = z.string().email();

function validateEmail(value: string): string | null {
  return EmailShapeSchema.safeParse(value).success
    ? null
    : "must be a well-formed email address";
}

/** The one refund setting this feature introduces (spec.md § Domain language). */
export const ACCOUNTING_DISTRIBUTION_EMAIL_KEY = "accounting-distribution-email";

const SETTINGS_REGISTRY: Readonly<Record<string, SettingDescriptor>> = {
  [ACCOUNTING_DISTRIBUTION_EMAIL_KEY]: {
    key: ACCOUNTING_DISTRIBUTION_EMAIL_KEY,
    label: "Accounting distribution email",
    validate: validateEmail,
  },
};

/** `undefined` means the key is not registered — callers must treat this as a 404 (never invent a key). */
export function getSettingDescriptor(key: string): SettingDescriptor | undefined {
  return SETTINGS_REGISTRY[key];
}
