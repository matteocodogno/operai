/**
 * addressCopy — IT/EN copy constants for every new string this feature adds
 * (T13, specs/012-employee-address/tasks.md, refs AC-1.1, AC-1.4, AC-3.1).
 *
 * `admin-ui` has no i18n runtime today (plan.md R11, a pre-existing,
 * app-wide gap this feature does not create or fix) — this module holds
 * `{ it, en }` pairs per key, the exact shape `auth/src/invite/invite.routes.ts`
 * already uses server-side (CLAUDE.md "no hardcoded UI strings… Italian and
 * English at minimum"). `AddressSection.tsx` (this remote, `admin-ui`) is the
 * ONLY consumer — see the `account.*` note below for why `shell`'s
 * `AccountScreen.tsx` is deliberately NOT one; no literal user-facing string
 * should appear in `AddressSection.tsx`.
 *
 * Locale heuristic (design.md fills a plan gap): `navigator.language`
 * starting with `"it"` selects `it`, everything else falls back to `en` — a
 * stateless, one-line heuristic scoped to this feature's own copy, not a
 * general i18n runtime (out of scope, design.md "Gaps").
 *
 * **`account.*` keys deliberately do NOT live here (QE fix,
 * specs/012-employee-address).** `shell`'s `AccountScreen.tsx`/`UserMenu.tsx`
 * render that copy, and `shell` is a SEPARATE federated remote — per ADR-0006
 * it cannot import `admin-ui`'s source at all, so an `account.*` entry in
 * THIS module could never be reached by them; `shell` carries its own inline
 * `{it,en}` copy for exactly this reason (see those files). An earlier
 * revision of this module wrongly duplicated `account.*` keys here as if
 * `AccountScreen.tsx` were a consumer of this file — it never was, and never
 * could be; those six keys were dead code and have been removed.
 *
 * **Country names are NOT i18n keys.** Every option label in the Country
 * combobox is produced at RUNTIME by `Intl.DisplayNames({ type: 'region' })`
 * (`countryDisplayName` below) — there is no hand-authored `{it, en}` pair
 * per country, and nobody should add one (design.md "Country control").
 * `ISO_3166_1_ALPHA2_CODES` is the only country-related data this module
 * ships, and it is codes only — 249 two-letter strings, not names.
 */

export type AddressLocale = 'it' | 'en'

/** `navigator.language` starting with "it" → `it`; everything else → `en`. SSR-safe (no `navigator` at module scope). */
export const resolveAddressLocale = (): AddressLocale => {
  if (typeof navigator === 'undefined' || typeof navigator.language !== 'string') return 'en'
  return navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en'
}

type CopyEntry = { it: string; en: string }

const COPY = {
  'address.sectionTitle': { it: 'Indirizzo', en: 'Address' },
  'address.currentLabel': { it: 'Indirizzo attuale: {formatted}', en: 'Current address: {formatted}' },
  'address.none': { it: 'Nessun indirizzo registrato', en: 'No address on file' },
  'address.field.street': { it: 'Via', en: 'Street' },
  'address.field.houseNumber': { it: 'Numero civico', en: 'House/building number' },
  'address.field.postalCode': { it: 'CAP', en: 'Postal code' },
  'address.field.city': { it: 'Città', en: 'City' },
  'address.field.region': { it: 'Regione / cantone / stato (opzionale)', en: 'Region / canton / state (optional)' },
  'address.field.country': { it: 'Paese', en: 'Country' },
  'address.field.requiredMark': { it: '(obbligatorio)', en: '(required)' },
  'address.field.requiredError': { it: 'Questo campo è obbligatorio.', en: 'This field is required.' },
  'address.save': { it: 'Salva indirizzo', en: 'Save address' },
  'address.saving': { it: 'Salvataggio…', en: 'Saving…' },
  'address.saveError': {
    it: "Impossibile salvare l'indirizzo. Riprova.",
    en: "Couldn't save this address. Try again.",
  },
  /** The address/history GET fetch failed with no server-supplied `ApiError` detail to fall back on (QE fix — was hardcoded, and wrongly reused for the SAVE failure too). */
  'address.loadError': {
    it: "Impossibile caricare l'indirizzo.",
    en: 'Could not load this address.',
  },
  'address.clear': { it: 'Cancella indirizzo', en: 'Clear address' },
  'address.clearPending': {
    it: "L'indirizzo sarà cancellato al salvataggio.",
    en: 'Address will be cleared when you save.',
  },
  'address.clearUndo': { it: 'Annulla', en: 'Undo' },
  'address.suggest.searching': { it: 'Ricerca in corso…', en: 'Searching…' },
  'address.suggest.noResults': {
    it: "Nessun suggerimento trovato — puoi comunque inserire l'indirizzo manualmente qui sotto.",
    en: 'No matching suggestions — you can still enter the address by hand below.',
  },
  'address.suggest.resultCount': { it: '{n} suggerimenti disponibili', en: '{n} suggestions available' },
  'address.suggest.noResultsAnnounce': { it: 'Nessun suggerimento trovato', en: 'No matching suggestions' },
  'address.country.placeholder': { it: 'Cerca un paese…', en: 'Search for a country…' },
  'address.country.noMatch': { it: 'Nessun paese corrispondente', en: 'No matching country' },
  'address.country.resultCount': { it: '{n} paesi corrispondenti', en: '{n} countries match' },
  'address.coords.captured': {
    it: 'Coordinate geografiche: acquisite dal suggerimento.',
    en: 'Location coordinates: captured from suggestion.',
  },
  'address.coords.cleared': {
    it: 'Coordinate geografiche: rimosse — indirizzo modificato dopo la selezione di un suggerimento.',
    en: 'Location coordinates: cleared — address edited after selecting a suggestion.',
  },
  'address.coords.none': { it: 'Nessuna coordinata geografica registrata.', en: 'No coordinates on file.' },
  'address.history.title': { it: 'Cronologia indirizzo', en: 'Address history' },
  'address.history.empty': {
    it: "Nessuna modifica all'indirizzo registrata finora.",
    en: 'No address changes recorded yet.',
  },
  /** sr-only field labels prefixed onto each history-panel row (QE fix — wired up; the compact list has no visible table headers, per design.md, but a screen-reader user still benefits from knowing which value is which). */
  'address.history.columns.changedBy': { it: 'Modificato da', en: 'Changed by' },
  'address.history.columns.changedOn': { it: 'Modificato il', en: 'Changed on' },
  'address.history.columns.previous': { it: 'Precedente', en: 'Previous' },
  'address.history.columns.new': { it: 'Nuovo', en: 'New' },
  /** The history panel's own "Deleted user" fallback for a null `actorUserId` (QE fix — was hardcoded; mirrors `AuditPage.tsx`'s equivalent, still-hardcoded, `formatActor`, which is a pre-existing gap outside this feature's touch: scope). */
  'address.history.deletedUser': { it: 'Utente eliminato', en: 'Deleted user' },
  'address.loading': { it: 'Caricamento indirizzo…', en: 'Loading address…' },
  'address.retry': { it: 'Riprova', en: 'Retry' },
} as const satisfies Record<string, CopyEntry>

export type AddressCopyKey = keyof typeof COPY

/**
 * Resolves a copy key to its localized string, interpolating `{param}`
 * placeholders (e.g. `{formatted}`, `{n}`) if `params` is given. Defaults to
 * `resolveAddressLocale()` — pass `locale` explicitly for a deterministic
 * test or a component that already tracks the resolved locale itself.
 */
export const t = (
  key: AddressCopyKey,
  params?: Record<string, string | number>,
  locale: AddressLocale = resolveAddressLocale(),
): string => {
  let text: string = COPY[key][locale]
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// Google attribution (QE fix, specs/012-employee-address) — deliberately NOT
// a `COPY` entry, and deliberately NOT run through `t()`.
//
// design.md "Google attribution": "Never localized, never restyled… Google's
// terms govern its presentation, not this repo's design system" — Places
// API (New) terms require the "Powered by Google" mark, verbatim, whenever
// predictions are shown outside a Google Map (true here by construction:
// plan.md rejects a map). Trademark/attribution strings of this kind are
// conventionally never localized by the integrator, so this is exported as
// its own explicit, non-localized constant rather than folded into `COPY`
// (which would wrongly imply an `it` translation is either needed or
// permitted) — a recorded decision, not a stray literal left in
// `AddressSection.tsx`. Only ever rendered inside the Street/address
// suggestion popup (never the Country popup, which sources no Google data —
// see design.md "Screens & states" and the component inventory).
// ---------------------------------------------------------------------------
export const GOOGLE_ATTRIBUTION_TEXT = 'Powered by Google'

// ---------------------------------------------------------------------------
// Country control support (design.md "Country control — resolved
// design↔plan mismatch") — a bundled, static ISO 3166-1 alpha-2 code list.
// Names are NEVER hand-authored here; see `countryDisplayName` below.
// ---------------------------------------------------------------------------

/** Every ISO 3166-1 alpha-2 country/territory code, generated once — codes only, never names. */
export const ISO_3166_1_ALPHA2_CODES: readonly string[] = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]

/**
 * Localized display name for an ISO 3166-1 alpha-2 code, via
 * `Intl.DisplayNames` — the SAME standard Web API
 * `auth/src/profile/address.format.ts` already uses server-side for the
 * `formatted` string's country/region segments (plan.md R8). Defensive
 * fallback: if `Intl.DisplayNames` is unavailable in the admin's browser, or
 * returns `undefined` for a given code, falls back to the raw alpha-2 code —
 * degraded, never broken, never blocking a save. Never throws.
 */
export const countryDisplayName = (code: string, locale: AddressLocale = resolveAddressLocale()): string => {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DisplayNames === 'undefined') return code
    const displayNames = new Intl.DisplayNames([locale], { type: 'region' })
    return displayNames.of(code) ?? code
  } catch {
    return code
  }
}
