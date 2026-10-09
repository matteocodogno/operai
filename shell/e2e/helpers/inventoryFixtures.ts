/**
 * Test-only fixture bridge for specs/015-hardware-inventory e2e (T45).
 *
 * Inventory access is deliberately admin-assigned (spec AC-9.6: the `employee`
 * role carries nothing), and the manager / accountant grants are
 * entity-conditioned (ADR-0015), so a user needs BOTH a real role and a
 * `user.entity`. There is no test-only "make me an inventory manager" endpoint
 * (nor should there be); this mirrors `refundFixtures.ts` and shells out to
 * `auth/scripts/e2e-invite-fixtures.ts` (`grant-inventory-role`), which writes
 * the real UserRole row and bumps `perm_epoch`, so inventory-api's live
 * `GET /authz/resolve` resolves these users exactly like an admin-granted one.
 *
 * It also holds the small inventory-api / notify-api REST helpers the specs use
 * for SETUP and for out-of-band verification (a notification landed, an asset's
 * state). Every assertion about what a person sees is made through the browser.
 *
 * Closing a fiscal year is irreversible (row-level triggers, ADR-0046) and the
 * `inventory` database is shared with local dev, so `pickClosableYear` chooses
 * the year to close dynamically instead of assuming a clean database.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SeededSession } from './adminSession'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '../../../auth')

export const INVENTORY_API_URL = (
  process.env['E2E_INVENTORY_API_URL'] ??
  process.env['VITE_INVENTORY_API_URL'] ??
  'http://localhost:8083'
).replace(/\/$/, '')

export const NOTIFY_API_URL = (
  process.env['E2E_NOTIFY_API_URL'] ??
  process.env['VITE_NOTIFY_API_URL'] ??
  'http://localhost:8081'
).replace(/\/$/, '')

export type InventoryEntity = 'welld_ch' | 'welld_it'
export type InventoryRole = 'inventory-manager' | 'accounting' | 'admin'

function runFixtureScript(args: string[]): string {
  const output = execFileSync('direnv', ['exec', '.', 'bun', 'run', 'scripts/e2e-invite-fixtures.ts', ...args], {
    cwd: AUTH_DIR,
    encoding: 'utf-8',
  })
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith('{')) return lines[i]!
  }
  throw new Error(`[inventoryFixtures] no JSON output from fixture script (args: ${args.join(' ')})\n${output}`)
}

/**
 * Gives the (already test-auth-seeded) user a REAL inventory role and sets its
 * entity. `inventory-manager` holds `inventory:access` + `asset:manage`;
 * `accounting` holds `inventory:access` + `ledger:manage`; both scoped to the
 * user's own entity. Re-grant AFTER minting the session token: the grant bumps
 * `perm_epoch`, and a token minted earlier simply re-resolves live (ADR-0007).
 */
export function grantInventoryRole(email: string, role: InventoryRole, entity: InventoryEntity): void {
  runFixtureScript(['grant-inventory-role', email, role, entity])
}

type Json = Record<string, unknown>

/** A JSON call to inventory-api as `session`; throws with the Problem body on any unexpected status. */
export async function inventoryCall<T = Json>(
  session: SeededSession,
  method: 'GET' | 'POST' | 'PATCH',
  route: string,
  body?: unknown,
  expect: number[] = [200, 201],
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${INVENTORY_API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!expect.includes(res.status)) {
    throw new Error(`[inventoryFixtures] ${method} ${route} -> ${res.status}: ${text}`)
  }
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T }
}

export interface RegisteredAsset {
  id: string
  entity: InventoryEntity
  description: string
  status: string
  purchaseDate: string
}

/** Registers one asset through the API (setup only; the manager journey registers through the UI). */
export async function registerAssetViaApi(
  session: SeededSession,
  input: {
    entity: InventoryEntity
    category: string
    description: string
    purchaseDate: string
    totalPriceCents: number
    serialNumbers?: string[]
  },
): Promise<RegisteredAsset> {
  const { body } = await inventoryCall<{ assets: RegisteredAsset[] }>(session, 'POST', '/assets', {
    quantity: 1,
    ...input,
  })
  return body.assets[0]!
}

export interface NotificationItem {
  id: string
  title: string
  body: string
  link: { href: string } | null
}

/** Reads a user's notification list straight from notify-api (proves the push landed, independent of the UI). */
export async function fetchNotifications(token: string): Promise<NotificationItem[]> {
  const res = await fetch(`${NOTIFY_API_URL}/notifications`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`[inventoryFixtures] GET /notifications failed (${res.status})`)
  return ((await res.json()) as { items: NotificationItem[] }).items
}

interface YearsList {
  years: { year: number; status: 'open' | 'closed'; closable: boolean }[]
}
interface YearView {
  assets: { description: string }[]
}

/** First year used when an entity has no fiscal year at all. Old enough to be unambiguous, never in the future. */
const BASE_YEAR = 2020

/** Every asset e2e registers for the ledger journey carries this description prefix (see pickClosableYear). */
export const E2E_ASSET_PREFIX = 'e2e-'

/**
 * Chooses WHICH entity and year the ledger journey may close, without poisoning
 * the shared `inventory` database for later runs or for local dev:
 *
 *   - a year closes strictly in order, once (no reopen), and never after the
 *     current UTC year, so each run consumes the next year of an entity
 *     (welld_it first, then welld_ch): 2020..current, about 7 runs per entity;
 *   - the chosen year is either the entity's first (no fiscal year exists yet:
 *     BASE_YEAR) or the single `closable` year of the list. It is refused when
 *     that year already holds an asset that is NOT ours (description without
 *     the `e2e-` prefix): the journey never freezes real data.
 *
 * Returns null when no entity qualifies; the caller fails with an explicit message.
 */
export async function pickClosableYear(
  accountant: SeededSession,
  currentYear: number,
): Promise<{ entity: InventoryEntity; year: number } | null> {
  // welld_it first: the assignment journeys register their assets on welld_ch, which
  // pins that entity's FIRST year to the current one, leaving it a single closable year.
  for (const entity of ['welld_it', 'welld_ch'] as const) {
    const { body } = await inventoryCall<YearsList>(accountant, 'GET', `/fiscal-years?entity=${entity}`)
    let year: number
    if (body.years.length === 0) {
      year = BASE_YEAR
    } else {
      const closable = body.years.find((y) => y.closable && y.status === 'open')
      if (!closable) continue
      year = closable.year
    }
    if (year > currentYear) continue
    if (body.years.length > 0) {
      const { body: view } = await inventoryCall<YearView>(accountant, 'GET', `/fiscal-years/${entity}/${year}`)
      if (view.assets.some((a) => !a.description.startsWith(E2E_ASSET_PREFIX))) continue
    }
    return { entity, year }
  }
  return null
}

/**
 * The year in which an e2e asset may still be registered on `entity`: any write
 * dated in a closed year is a 409 `fiscal_year_closed`, and the ledger journey
 * closes years for good, so a hard-coded year would break the assignment
 * journeys after the first ledger run. This is the current year, or the one
 * after the last closed year when that is later (never earlier than today's).
 */
export async function openRegistrationYear(
  ledgerSession: SeededSession,
  entity: InventoryEntity,
  currentYear: number,
): Promise<number> {
  const { body } = await inventoryCall<YearsList>(ledgerSession, 'GET', `/fiscal-years?entity=${entity}`)
  const lastClosed = Math.max(0, ...body.years.filter((y) => y.status === 'closed').map((y) => y.year))
  return Math.max(currentYear, lastClosed + 1)
}
