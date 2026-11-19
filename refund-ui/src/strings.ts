/**
 * strings — the single source of every user-facing string in refund-ui
 * (T14, specs/20260716-refund-service/tasks.md: "src/strings.ts: a centralized
 * strings module holding ALL user-facing copy in English for v1 … so NO
 * hardcoded UI strings appear in JSX").
 *
 * Two catalogs (INC-24/INC-25): `en` and `it` (typed `Strings`, the shape of
 * `en`), exported as `strings = selectStrings({ en, it })` — the language is
 * resolved once by @operai/ui. Every string lives under a stable, namespaced
 * key path; a sentence with a value in it is a FUNCTION, because word order
 * around the value differs between the languages. `strings.parity.test.ts`
 * runs `catalogGaps(en, it)`; `lib/noHardcodedStrings.test.ts` scans every
 * component for inline copy.
 *
 * Canonical document labels (expense types, entities, request statuses) are
 * shared with refund-api's PDFs, which are English: `en` must keep matching
 * refund-api/src/requests/document-labels.json (documentLabels.parity.test.ts).
 *
 * T15 addition (specs/20260716-refund-service/tasks.md: "ported shared components
 * + badges … All copy via strings.ts"): the `components` and `badges`
 * namespaces below hold copy for the five ported patterns (`ErrorBanner`,
 * `SkeletonListRows`, `ConfirmDeleteModal`, `GuardrailDialog`,
 * `PermissionDenied`) and the two new badges (`RequestStatusBadge`,
 * `EntityBadge`). A couple of entries are FUNCTIONS, not plain strings
 * (`confirmDeleteModal.title`/`defaultBody`) — deliberately, since their
 * exact wording depends on a runtime value (the entity/item name) AND, for a
 * future non-English locale, sentence structure/word order around that
 * interpolation can differ by language (a fixed prefix+suffix pair would not
 * survive translation) — same reasoning `Strings` being exported already
 * documents for the rest of this file's i18n-readiness.
 *
 * T17/T18 addition (specs/20260716-refund-service/tasks.md): `components.
 * attachmentList` (upload/download copy shared by `AttachmentList`'s draft
 * mode and `AttachmentDownloadLink`'s read-only mode), and the real
 * `pages.reviewQueue`/`pages.reviewDetail` (Screens A1/A2, replacing T14's
 * placeholders). `NO_MOTIVO_FALLBACK` is hoisted above `en` (not inlined
 * per-use) so the same "(no description)" wording the submit-validation
 * summary (T16) already uses is also reused by the approved-total input's
 * disambiguating `aria-label` — a literal object can't reference its own
 * other branches while being built.
 */

import { selectStrings } from '@operai/ui'

const NO_MOTIVO_FALLBACK = '(no description)'

/**
 * ownerDisplay — the single place that resolves a request owner's display
 * name, guarding against `owner.name` being `null` (QE-verified defect,
 * specs/20260716-refund-service: `refund-api` never populates `RefundRequest.
 * ownerName` because the JWT carries no `name` claim, only `sub`/`email` —
 * so the wire contract is `name: string | null`, never guaranteed present).
 * Falls back to the owner's email so accounting screens NEVER render the
 * literal string "null" in place of a name. Every call site that displays
 * an owner's name (ReviewQueuePage's row, ReviewDetailPage's confirmation
 * copy and decision dialogs) MUST route through this helper rather than
 * reading `owner.name` directly.
 */
export const ownerDisplay = (owner: { email: string; name: string | null }): string =>
  owner.name && owner.name.trim().length > 0 ? owner.name : owner.email

const en = {
  appTitle: 'Refund',
  /** Units shown beside a figure. */
  units: {
    /** A per-km mileage rate: `rate` is already formatted with its currency ("CHF 0.70"). */
    perKm: (rate: string) => `${rate}/km`,
  },
  nav: {
    landmarkLabel: 'Refund navigation',
    myRequests: 'My requests',
    reviewQueue: 'Review queue',
    monthlyProcessing: 'Monthly processing',
    settings: 'Settings',
  },
  /**
   * Accounting's reference data is read through refund-api; when it cannot be read, each refusal says the
   * cause and the remedy and what stayed (specs/20261119-accounting, AC-6.10, UX-21). No address, identifier or
   * internal text.
   */
  accountingUnavailable: {
    cause: "Accounting's reference data cannot be read right now.",
    approve: "Accounting's reference data cannot be read right now. Nothing was approved. Try again in a few minutes.",
    classify:
      "Accounting's reference data cannot be read right now. The classification was not changed. Try again in a few minutes.",
    save: "Accounting's reference data cannot be read right now. Nothing was saved. Try again in a few minutes.",
    options:
      "Accounting's reference data cannot be read right now, so there is nothing to choose from. Try again in a few minutes.",
  },
  /** The Settings tab: mileage rates and the accounting distribution email (moved from Admin, 2026-11-13). */
  settings: {
    heading: 'Settings',
    description: 'The per-km mileage rate of each entity and the address that receives the monthly batch.',
    entityRates: (entity: string) => `Mileage rates · ${entity}`,
    loading: 'Loading mileage rates…',
    loadError: 'Could not load the mileage rates.',
    forbidden: "You don't have permission to view mileage rates.",
    forbiddenTitle: 'No access to mileage rates',
    /** A rate already formatted as a number, with its currency per km ("CHF 0.81/km"). */
    perKm: (rate: string, currency: string) => `${currency} ${rate}/km`,
    caption: (entity: string) => `${entity} mileage rates`,
    columns: {
      rate: 'Rate',
      validFrom: 'Valid from',
      addedBy: 'Added by',
      addedOn: 'Added on',
      status: 'Status',
    },
    inEffect: 'In effect',
    addRateEntry: 'Add rate entry',
    added: (entity: string) => `Rate entry added for ${entity}`,
    addFailed: 'Could not add this rate entry. Try again.',
    empty: {
      title: 'No rate yet',
      body: (entity: string) => `No rate configured yet for ${entity}.`,
    },
    rateError: 'Enter a rate greater than 0.',
    validFromError: 'Enter a valid date.',
    addDialog: {
      title: (entity: string) => `Add rate entry — ${entity}`,
      description: 'This entry cannot be edited or deleted once saved — a correction is always a new entry.',
      busy: 'Adding…',
      rate: 'Rate per km',
      validFrom: 'Valid from',
      validFromHint: 'Past, present, or future dates are all accepted.',
      cancel: 'Cancel',
    },
    email: {
      title: 'Accounting distribution email',
      description: 'The email address that receives each monthly refund batch. Leave it blank to pause sending.',
      loading: 'Loading the accounting distribution email…',
      loadError: 'Could not load the accounting distribution email.',
      saved: 'Accounting distribution email saved',
      cleared: 'Accounting distribution email cleared',
      currentValue: 'Current value',
      notConfigured: 'Not configured',
      emailAddress: 'Email address',
      placeholder: 'accounting@welld.ch',
      save: 'Save',
      clear: 'Clear',
      historyTitle: 'Change history',
      historyEmpty: 'No changes recorded yet.',
      historyItem: (value: string, by: string, at: string) => `${value} — ${by} — ${at}`,
    },
    dismiss: 'Dismiss',
    /** specs/20261118-refund-accounting-export: the page description once it has more than the mileage rates. */
    descriptionAll: 'The mileage rates and the default classification of expense types.',
    /** The Settings views (UX-1). */
    sections: {
      label: 'Settings sections',
      general: 'General',
      accounting: 'Accounts and VAT',
      exchangeRates: 'Exchange rates',
      /** specs/20261119-accounting UX-16: the second Settings view. */
      defaults: 'Default classification',
    },
    /** The note that heads the Default classification view (specs/20261119-accounting, AC-4.6, UX-16, UX-17). */
    accountingLink: {
      withAccess: 'Ledger accounts, VAT codes and exchange rates are kept in the Accounting app.',
      linkText: 'Open Accounting',
      linkLabel: 'Open Accounting: ledger accounts, VAT codes and exchange rates',
      withoutAccess:
        'Ledger accounts, VAT codes and exchange rates are kept in the Accounting app by accounting managers. Ask one of them if an entry is missing.',
    },
    /** Shared by the ledger-account, VAT-code and default-classification cards and their dialogs. */
    catalog: {
      status: { active: 'Active', inactive: 'Inactive' },
      forbidden: "You don't have permission to do this.",
      genericError: 'Could not save. Try again.',
      cancel: 'Cancel',
      close: 'Close',
      none: 'None',
      inactiveTag: 'Inactive',
    },
    /** The change-history drawer, one component for defaults, the foreign-currency VAT code and exchange rates. */
    history: {
      title: (subject: string) => `History — ${subject}`,
      description: 'Every change, newest first.',
      empty: 'No changes recorded yet.',
      columns: { when: 'When', by: 'By', account: 'Account', vatCode: 'VAT code' },
      open: 'History',
      openLabel: (subject: string) => `Show the history of ${subject}`,
      closeLabel: 'Close the history',
    },
    accounts: {
      title: 'Ledger accounts',
      description: 'The accounts of the WellD CH chart of accounts that refunds may be booked to.',
      caption: 'WellD CH ledger accounts',
      loading: 'Loading ledger accounts…',
      loadError: 'Could not load the ledger accounts.',
      empty: { title: 'No ledger accounts yet', body: 'Add the accounts that refunds are booked to.' },
      columns: { number: 'Number', name: 'Name', status: 'Status', added: 'Added', actions: 'Actions' },
      addedBy: (by: string, on: string) => `${by} · ${on}`,
      add: 'Add account',
      addDialog: {
        title: 'Add ledger account',
        description: 'The number and name cannot be edited later. An account can be deactivated and reactivated.',
        number: 'Account number',
        numberHint: 'For example 5905 or 2620.1',
        name: 'Account name',
        busy: 'Adding…',
      },
      errors: {
        numberInvalid: 'Enter an account number such as 5905 or 2620.1.',
        nameRequired: 'Enter a name of up to 120 characters.',
        duplicate: (number: string) => `Account ${number} already exists.`,
        duplicateInactive: (number: string) =>
          `Account ${number} already exists but is deactivated. Reactivate it from the list.`,
        alreadyActive: (number: string) => `Account ${number} is already active.`,
        alreadyInactive: (number: string) => `Account ${number} is already deactivated.`,
      },
      added: (number: string) => `Account ${number} added`,
      deactivated: (number: string) => `Account ${number} deactivated`,
      reactivated: (number: string) => `Account ${number} reactivated`,
      deactivate: 'Deactivate',
      reactivate: 'Reactivate',
      deactivateLabel: (number: string) => `Deactivate account ${number}`,
      reactivateLabel: (number: string) => `Reactivate account ${number}`,
      deactivateDialog: {
        title: (number: string) => `Deactivate account ${number}?`,
        body: 'It can no longer be chosen as a default or on a line. Lines already classified with it keep it. An expense type that uses it as its default will have no default until you choose another. You can reactivate it at any time.',
        confirm: 'Deactivate',
        busy: 'Deactivating…',
      },
    },
    vatCodes: {
      title: 'VAT codes',
      description: 'The VAT codes refunds may use. Each carries one fixed rate.',
      caption: 'WellD CH VAT codes',
      loading: 'Loading VAT codes…',
      loadError: 'Could not load the VAT codes.',
      empty: { title: 'No VAT codes yet', body: 'Add the VAT codes that refunds may use.' },
      columns: { code: 'Code', label: 'Label', rate: 'VAT rate', status: 'Status', added: 'Added', actions: 'Actions' },
      addedBy: (by: string, on: string) => `${by} · ${on}`,
      add: 'Add VAT code',
      addDialog: {
        title: 'Add VAT code',
        description: 'The rate cannot be changed later: a new rate needs a new code.',
        code: 'Code',
        codeHint: 'Letters, digits, - and _ (up to 16). Saved in capitals.',
        label: 'Label',
        rate: 'VAT rate (%)',
        rateHint: 'Between 0 and 100, up to 2 decimals.',
        busy: 'Adding…',
      },
      errors: {
        codeInvalid: 'Enter a code of letters, digits, - or _ (up to 16).',
        labelRequired: 'Enter a label of up to 80 characters.',
        rateInvalid: 'Enter a rate between 0 and 100, with up to 2 decimals.',
        duplicate: (code: string) => `VAT code ${code} already exists.`,
        duplicateInactive: (code: string) =>
          `VAT code ${code} already exists but is deactivated. Reactivate it from the list.`,
        alreadyActive: (code: string) => `VAT code ${code} is already active.`,
        alreadyInactive: (code: string) => `VAT code ${code} is already deactivated.`,
      },
      added: (code: string) => `VAT code ${code} added`,
      deactivated: (code: string) => `VAT code ${code} deactivated`,
      reactivated: (code: string) => `VAT code ${code} reactivated`,
      deactivate: 'Deactivate',
      reactivate: 'Reactivate',
      deactivateLabel: (code: string) => `Deactivate VAT code ${code}`,
      reactivateLabel: (code: string) => `Reactivate VAT code ${code}`,
      deactivateDialog: {
        title: (code: string) => `Deactivate VAT code ${code}?`,
        body: 'It can no longer be chosen as a default, as the foreign-currency VAT code or on a line. Lines already classified with it keep it. Its rate never changes. You can reactivate it at any time.',
        confirm: 'Deactivate',
        busy: 'Deactivating…',
      },
    },
    defaults: {
      title: 'Default classification',
      description:
        'The account and VAT code each expense type gets in WellD CH. Accounting can change them line by line. Where a type has no default, accounting must choose on each line before approving.',
      caption: 'Default classification by expense type',
      loading: 'Loading the default classification…',
      loadError: 'Could not load the default classification.',
      columns: {
        type: 'Expense type',
        account: 'Default account',
        vatCode: 'Default VAT code',
        changed: 'Last changed',
        actions: 'Actions',
      },
      notSet: 'Not set yet',
      /** The state of an Accounting entry a default points to (UX-18); `active` has no mark. */
      state: {
        deactivated: 'Deactivated in Accounting',
        notFound: 'Not found in Accounting',
      },
      needsChoice: (n: number) =>
        n === 1
          ? '1 default needs a new choice: its entry is deactivated or no longer in Accounting. Lines of that type get no default until you choose another.'
          : `${n} defaults need a new choice: their entry is deactivated or no longer in Accounting. Lines of those types get no default until you choose another.`,
      /** Accounting cannot be read (AC-6.9, UX-19). */
      unavailable: {
        title: 'Accounting cannot be read now',
        body: 'The defaults are shown as recorded. You cannot change them until Accounting can be read.',
      },
      changeBlocked: 'Accounting cannot be read now, so defaults cannot be changed.',
      recovered: 'Accounting can be read again.',
      stillUnavailable: 'Accounting still cannot be read.',
      changedBy: (by: string, on: string) => `${by} · ${on}`,
      change: 'Change',
      changeLabel: (type: string) => `Change the default for ${type}`,
      historyLabel: (type: string) => `Show the history of the default for ${type}`,
      dialog: {
        title: (type: string) => `Default classification — ${type}`,
        description: 'Applies to lines reviewed from now on. Lines already approved keep what they have.',
        account: 'Default account',
        vatCode: 'Default VAT code',
        noneOption: 'None (no default)',
        chooseOption: 'Choose…',
        inactiveCurrent: (what: string) => `The current ${what} is deactivated. Choose another, or none.`,
        inactiveSentence: 'Lines of this type get no default until you choose another.',
        notFoundCurrent: (what: string) => `The current ${what} is no longer in Accounting. Choose another, or none.`,
        tryAgain: 'Try again',
        save: 'Save',
        busy: 'Saving…',
      },
      saved: (type: string) => `Default saved for ${type}`,
      errors: {
        accountInactive: 'That account has been deactivated. Choose another.',
        vatInactive: 'That VAT code has been deactivated. Choose another.',
        accountNotFound: 'That account is no longer in Accounting. Choose another.',
        vatNotFound: 'That VAT code is no longer in Accounting. Choose another.',
      },
      foreign: {
        term: 'VAT code for foreign-currency lines',
        description: 'WellD CH lines in a currency other than CHF get this code by default.',
        none: 'None designated',
        inactiveWarning: (code: string) =>
          `${code} is deactivated, so foreign-currency lines get no VAT code until you designate another.`,
        notFoundWarning: (code: string) =>
          `${code} is no longer in Accounting, so foreign-currency lines get no VAT code until you designate another.`,
        dialogTitle: 'VAT code for foreign-currency lines',
        saved: 'Foreign-currency VAT code saved',
        historyLabel: 'the foreign-currency VAT code',
        changeLabel: 'Change the VAT code for foreign-currency lines',
      },
    },
    fx: {
      title: 'Monthly exchange rates',
      description:
        'CHF for 1 unit of the foreign currency, monthly average. Used for the CHF amount in the accounting export.',
      caption: 'Monthly average exchange rates',
      loading: 'Loading exchange rates…',
      loadError: 'Could not load the exchange rates.',
      empty: { title: 'No months to show yet', body: 'No completed month has rates to show.' },
      columns: { month: 'Month' },
      origin: { fetched: 'Fetched', corrected: 'Corrected' },
      missing: 'Missing',
      correct: 'Correct',
      correctLabel: (currency: string, month: string) => `Correct the ${currency} rate for ${month}`,
      cellLabel: (currency: string, month: string, rate: string, origin: string) =>
        `${currency}, ${month}: ${rate}, ${origin}`,
      cellMissingLabel: (currency: string, month: string) => `${currency}, ${month}: missing`,
      fetchNow: 'Fetch now',
      fetching: 'Fetching…',
      checking: 'Checking for new rates…',
      fetchedOk: (n: number) => (n === 1 ? 'Recorded the rates for 1 month.' : `Recorded the rates for ${n} months.`),
      nothingNew: 'No new rates to record.',
      throttled: 'The rates were checked a moment ago. Try again in a few minutes.',
      deferred: (n: number) =>
        n === 1
          ? '1 more month is still to fetch. Fetch again to continue.'
          : `${n} more months are still to fetch. Fetch again to continue.`,
      fetchError: 'Could not fetch the rates. Try again.',
      notFetchable: (month: string) => `The rates for ${month} are not published yet.`,
      disabled: 'Automatic fetching is turned off in this environment. Enter the rates by hand.',
      lastFetch: {
        term: 'Last fetch',
        never: 'No fetch yet',
        ok: (at: string) => `${at} — succeeded`,
        failed: (at: string) => `${at} — failed`,
        disabled: (at: string) => `${at} — skipped, automatic fetching is turned off`,
        notFetchable: (at: string) => `${at} — the rates are not published yet`,
        throttled: (at: string) => `${at} — skipped, the rates were checked a moment ago`,
        failedTitle: 'The last fetch failed',
        failedBody: (at: string, reason: string) => `On ${at}: ${reason}. The rates already recorded are unchanged.`,
      },
      reason: {
        timeout: 'the official source did not answer in time',
        http: 'the official source returned an error',
        parse: 'the answer could not be read',
        monthMismatch: 'the answer was for a different month',
        currencyMissing: 'a currency was missing from the answer',
        unknown: 'an unknown error occurred',
      },
      correction: {
        title: (currency: string, month: string) => `Correct rate — ${currency} · ${month}`,
        description:
          'The previous value stays in the history. A batch exported before this correction will export differently if it is exported again.',
        rate: (currency: string) => `Rate (CHF per 1 ${currency})`,
        inEffect: (rate: string, origin: string) => `In effect: ${rate} (${origin})`,
        rateInvalid: 'Enter a rate greater than 0, with up to 6 decimals.',
        monthNotCompleted: 'This month is not finished yet; its rate cannot be corrected.',
        save: 'Save correction',
        busy: 'Saving…',
        saved: (currency: string, month: string) => `${currency} rate for ${month} corrected`,
      },
      history: { rateColumn: 'Rate', originColumn: 'Origin' },
      historyLabel: (currency: string, month: string) => `the ${currency} rate for ${month}`,
    },
  },
  pages: {
    myRequests: {
      heading: 'My requests',
      newRequestButton: 'New request',
      loadingAnnouncement: 'Loading your requests',
      loadErrorFallback: 'Could not load your requests.',
      empty: {
        heading: 'Ready to submit your first expense request?',
        body: 'Add expense lines, attach receipts, and submit for accounting to review — right from here.',
      },
      /** Dismiss (×) on the one-shot confirmation banner (e.g. after deleting a draft). */
      confirmationDismissLabel: 'Dismiss',
      row: {
        updatedLabel: (date: string) => `Updated ${date}`,
        openLabel: (label: string) => `Open request updated ${label}`,
      },
    },
    newRequest: {
      heading: 'New request',
      placeholder: 'Starting a new refund request will draft it here.',
      creatingAnnouncement: 'Creating your request…',
      createError: 'Could not create a new request.',
      tryAgain: 'Try again',
      backToMyRequests: 'Back to my requests',
    },
    requestDetail: {
      heading: 'Request',
      loadingAnnouncement: 'Loading this request',
      loadErrorFallback: 'Could not load this request.',
      notFound: {
        heading: 'Request not found',
        body: 'This request doesn’t exist or you don’t have access to it.',
        backLink: 'Back to my requests',
      },
      composer: {
        heading: 'Add expense line',
        dateLabel: 'Date',
        typeLabel: 'Expense type',
        typePlaceholder: 'Select a type…',
        motivoLabel: 'Motivo',
        amountLabel: 'Requested amount',
        entityLabel: 'Entity',
        entityPlaceholder: 'Select an entity…',
        currencyLabel: 'Currency',
        currencyPlaceholder: 'Select a currency…',
        kmLabel: 'Distance (km)',
        kmHelp: 'Must be greater than 0',
        kmFieldAdded: 'Mileage field added — km is required for travel by car',
        kmFieldRemoved: 'Mileage field removed — not applicable for this expense type',
        addButton: 'Add expense line',
        addingLabel: 'Adding…',
        genericError: 'Could not add this expense line. Check the fields and try again.',
        /** Per-field errors (INC-16), shown on blur of a touched field and on a failed "Add"/"Done". Shared by the composer and the in-place line editor. */
        fieldErrors: {
          date: 'Enter the date of the expense.',
          type: 'Choose an expense type.',
          motivo: 'Enter a motivo.',
          amount: 'Enter an amount such as 45,50 — at most two decimals.',
          entity: 'Choose an entity.',
          currency: 'Choose a currency.',
          km: 'Enter a distance greater than 0.',
        },
        /**
         * Announced on the composer's EXISTING polite status line
         * (`composer-km-status`) after a motivo suggestion is picked (T10,
         * specs/20260811-motivo-autocomplete; AC-3.1/AC-3.2/AC-5.6; design.md
         * "## After a pick — making the multi-field change perceivable").
         *
         * Three fields change at once and a fourth (the amount) re-derives a
         * beat later; for a non-visual user every other cue design.md relies on
         * (the list closing, the atomic commit, the amount breakdown, the
         * caret) is silent, so this sentence carries the whole change.
         * Naming the untouched DATE is deliberate — it is the one field a
         * picker might reasonably assume was filled too (AC-3.2).
         */
        suggestionApplied: (motivo: string, km: number, entity: string) =>
          `Filled from a past trip: ${motivo}, ${km} km, ${entity}. The date is unchanged.`,
      },
      lines: {
        emptyDraft: 'No expense lines yet — add one to get started.',
        /** Heading above the committed-lines list (post-close UX amendment, specs/20260716-refund-service, 2026-07-17): "Expense lines (N)". */
        sectionHeading: (count: number) => `Expense lines (${count})`,
        /** A line's distance, and the distance with the per-km rate it was priced at. */
        kmValue: (km: number) => `${km} km`,
        kmWithRate: (km: number, rate: string) => `${km} km × ${rate}`,
        requestedLabel: 'Requested',
        approvedLabel: 'Approved',
        /**
         * The adjustment note, shown BENEATH the approved figure when
         * accounting changed it — "requested 180,00 · −26,00".
         *
         * Deliberately a second line rather than a parenthetical appended to
         * the figure. Amounts are a right-aligned column an accountant reads
         * down to check it sums; an inline "(requested …, …)" would push each
         * approved figure to a different horizontal position and destroy the
         * one property the column exists for. The figures stay aligned, the
         * adjustment hangs underneath.
         *
         * Only the approved figure carries the currency — repeating it three
         * times in one phrase is noise.
         *
         * When nothing was adjusted, no note is rendered at all: a reviewer
         * scanning for what got cut should see nothing where nothing was cut.
         */
        approvedDeltaNote: (requested: string, delta: string) => `requested ${requested} · ${delta}`,
        /** "N files"/"1 file" — the collapsed summary row's small attachment indicator (post-close amendment, specs/20260716-refund-service). */
        attachmentsIndicator: (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`,
        editButton: 'Edit',
        deleteButton: 'Delete',
        doneButton: 'Done',
        editLineLabel: (motivo: string) => `Edit line “${motivo || NO_MOTIVO_FALLBACK}”`,
        editLineTitle: 'Edit this expense line',
        doneLabel: (motivo: string) => `Done editing line “${motivo || NO_MOTIVO_FALLBACK}”`,
        doneTitle: 'Collapse this expense line back to a summary',
        deleteLineLabel: (motivo: string) => `Delete line “${motivo || NO_MOTIVO_FALLBACK}”`,
        /** Hover tooltip (`title`) on the summary row's Delete button. Post-close amendment (specs/20260716-refund-service, 2026-07-17): deleting a committed line now opens `deleteLineConfirmTitle`/`deleteLineConfirmBody` — overrides the original no-confirm decision. */
        deleteLineTitle: 'Delete this expense line',
        deleteLineConfirmEntityLabel: 'expense line',
        deleteLineConfirmTitle: 'Delete this expense line?',
        deleteLineConfirmBody: (typeLabel: string, motivo: string) =>
          `“${typeLabel} — ${motivo || NO_MOTIVO_FALLBACK}” will be permanently deleted. This cannot be undone.`,
        savingLabel: 'Saving…',
        updateError: 'Could not save this change. Check the fields and try again.',
        deleteError: 'Could not delete this expense line. Try again.',
        /** Success toast copy for a debounced auto-save or an immediate blur/Done flush (content-app auto-save). */
        savedToast: 'Changes stored',
        /** INC-19: confirmations shown in the same page-level compact banner as `savedToast`. */
        addedToast: 'Expense line added',
        deletedToast: 'Expense line deleted',
        /** `summaryCore`'s new "Rate applied" row (specs/20260720-mileage-rate, T13/T14, AC-6.4) — shown whenever `line.mileage.appliedRate` is non-null, in every mode `summaryCore` renders in. */
        rateAppliedLabel: 'Rate applied',
        rateAppliedValue: (rate: string, validFrom: string) => `${rate} · valid from ${validFrom}`,
        /**
         * specs/20260716-refund-service amendment (2026-11-10) — a line the reviewer refused on its
         * own. The badge is the line's status; the reason is what the employee
         * is owed, shown under the motivo on every decided-and-paid render.
         */
        rejectedBadge: 'Line rejected',
        rejectionReasonLabel: 'Reason for rejection',
        /** Replaces the "Requested" `<dd>`'s `formatMoney` call when a travel_km line's mileage is blocked (no rate configured, AC-2.2) — never a stale/zero amount. */
        mileageBlockedAmount: '—',
        /** Visually hidden label of a line's receipt number (specs/20261118-refund-accounting-export, design S9). */
        receiptNumberLabel: 'Receipt number',
      },
      /** Title of the per-currency totals card (INC-33). */
      totalsHeading: 'Totals',
      submit: {
        button: 'Submit for review',
        submittingLabel: 'Submitting…',
        blockedNote: 'Add at least one expense line before submitting.',
        confirmation: 'Submitted — now awaiting accounting’s decision',
        genericError: 'Could not submit this request. Try again.',
      },
      withdraw: {
        button: 'Withdraw',
        withdrawingLabel: 'Withdrawing…',
        confirmation: 'Withdrawn — back to draft',
        guardrailTitle: 'This request has already been decided',
        guardrailMessage: 'This request has already been decided and can no longer be withdrawn.',
        genericError: 'Could not withdraw this request. Try again.',
      },
      guardrail: {
        title: 'This request has already been decided',
        message: 'This request has already been decided and can no longer be changed.',
      },
      deleteRequest: {
        button: 'Delete request',
        entityLabel: 'request',
        body: (lineCount: number) =>
          `Delete this draft request and its ${lineCount} expense line${lineCount === 1 ? '' : 's'}? This cannot be undone.`,
        /** INC-19: said by the destination (My requests) after the delete navigates there. */
        confirmation: 'Draft request deleted',
        genericError: 'Could not delete this request. Try again.',
      },
      validationSummary: {
        heading: 'Some expense lines need attention before you can submit.',
        jumpLinkLabel: (label: string) => `Go to ${label}`,
        fallbackLineLabel: (lineId: string) => `Line ${lineId}`,
        noMotivo: NO_MOTIVO_FALLBACK,
      },
      statusBadges: {
        submittedNote: 'Every field is read-only while a decision is pending.',
      },
      rejected: {
        motivationHeading: 'Reason for rejection',
        newRequestLink: 'New request',
      },
      /** `paid` render branch (T13, specs/20260719-refund-monthly-processing/tasks.md, design.md F5) — sibling to draft/submitted/approved/rejected. */
      paid: {
        paidLine: (date: string) => `Paid on ${date}`,
      },
      /**
       * A footnote under an approved request's totals, not a banner. The
       * `heading` this used to carry ("Monthly processing") is gone: at body
       * weight the sentence introduces itself, and a heading existed only to
       * anchor the panel that no longer surrounds it.
       */
      monthlyNote: {
        body: 'Approved reimbursements are processed together on a regular monthly cycle. No specific date or payout amount is promised here — check with accounting for the current schedule.',
      },
    },
    reviewQueue: {
      heading: 'Review queue',
      /** Dismiss (×) on the visible one-shot confirmation banner (INC-19). */
      confirmationDismissLabel: 'Dismiss',
      scopeHint: 'Showing requests for your scope',
      loadingAnnouncement: 'Loading the review queue',
      loadErrorFallback: 'Could not load the review queue.',
      empty: {
        heading: 'Nothing to review',
        body: 'Nothing awaiting your decision right now.',
      },
      row: {
        openLabel: (employeeName: string, date: string) => `Open ${employeeName}’s request submitted ${date}`,
        submittedLabel: (date: string) => `Submitted ${date}`,
      },
    },
    reviewDetail: {
      heading: 'Review detail',
      loadingAnnouncement: 'Loading this request',
      loadErrorFallback: 'Could not load this request.',
      /**
       * `owner.name` can be `null` (see `ownerDisplay`'s doc comment) — when
       * absent, show the email alone rather than duplicating it as both the
       * name and the parenthetical (`Requested by bob@x (bob@x)`).
       */
      requestedByLabel: (owner: { email: string; name: string | null }) =>
        owner.name && owner.name.trim().length > 0
          ? `Requested by ${owner.name} (${owner.email})`
          : `Requested by ${owner.email}`,
      notFound: {
        heading: 'Request not found',
        body: 'This request doesn’t exist or you don’t have access to it.',
        backLink: 'Back to the review queue',
      },
      guardrail: {
        title: 'This request has already been decided',
        message: 'This request has already been decided and can no longer be changed.',
      },
      approvedTotal: {
        label: 'Approved total',
        ariaLabel: (date: string, motivo: string, currency: string) =>
          `Approved total for ${date} · ${motivo || NO_MOTIVO_FALLBACK} · ${currency}`,
        savingLabel: 'Saving…',
        updateError: 'Could not save this change. Try again.',
        invalidAmount: 'Enter a valid, non-negative amount.',
      },
      /**
       * specs/20260716-refund-service amendment (2026-11-10) — rejecting ONE line instead of the
       * whole request. The reason is required: the employee is owed an
       * explanation for every euro not reimbursed. Reversible until the
       * request is decided ("Restore line").
       */
      lineReject: {
        rejectButton: 'Reject line',
        rejectButtonLabel: (motivo: string) => `Reject line “${motivo || NO_MOTIVO_FALLBACK}”`,
        restoreButton: 'Restore line',
        restoreButtonLabel: (motivo: string) => `Restore line “${motivo || NO_MOTIVO_FALLBACK}”`,
        rejectedBy: (email: string) => `Rejected by ${email}`,
        dialogTitle: 'Reject this expense line?',
        dialogBody: (typeLabel: string, motivo: string, amount: string) =>
          `“${typeLabel} — ${motivo || NO_MOTIVO_FALLBACK}” (${amount}) will not be reimbursed. The rest of the request stays under review, and you can restore the line until the request is decided.`,
        reasonLabel: 'Reason for rejection',
        reasonHelp: 'Required — the employee will see this explanation.',
        reasonRequired: 'Enter the reason for rejecting this line.',
        cancelLabel: 'Cancel',
        closeLabel: 'Close',
        confirmLabel: 'Reject line',
        busyLabel: 'Rejecting…',
        updateError: 'Could not update this line. Try again.',
      },
      decide: {
        approveButton: 'Approve',
        rejectButton: 'Reject',
        approveConfirmation: (employeeName: string) => `Approved — ${employeeName}’s request`,
        rejectConfirmation: (employeeName: string) => `Rejected — ${employeeName}’s request`,
        genericError: 'Could not record this decision. Try again.',
        /**
         * specs/20260721-self-approval-control (plan.md D5, ADR 20260721-self-approval-condition-and-403-exception) — passive,
         * convenience-only client reflection of the self-approval
         * segregation-of-duties control; the server 403 is authoritative.
         * `selfApprovalTooltip` explains the disabled Approve button
         * (`aria-disabled` + `title` house pattern, mirrors
         * admin-ui's UserDetail.tsx "You can't delete your own account").
         * `selfApprovalForbiddenError` is the localized copy shown in the
         * decision-dialog error slot if the action is somehow attempted
         * anyway (stale state) and refund-api's 403 carries
         * `code: "self_approval_forbidden"` — never the server's raw
         * `detail` string, per CLAUDE.md's "no hardcoded strings" mandate.
         */
        selfApprovalTooltip: 'You cannot approve a refund request you submitted yourself.',
        selfApprovalForbiddenError: 'You cannot approve a refund request you submitted yourself.',
        /** Every line is rejected: approving would pay nothing — the request must be rejected instead (refund-api 409 `all_lines_rejected`). */
        allLinesRejectedTooltip: 'Every line is rejected — reject the request instead.',
      },
      approveDialog: {
        title: 'Approve this request?',
        body: (employeeName: string) =>
          `Approved totals become final the moment you confirm, and ${employeeName} is notified immediately.`,
        confirmLabel: 'Approve',
        confirmingLabel: 'Approving…',
      },
      rejectDialog: {
        title: 'Reject this request?',
        body: (employeeName: string) =>
          `${employeeName} is notified immediately, with the reason below. This cannot be undone.`,
        motivationLabel: 'Reason for rejection',
        motivationHelp: 'Required — the employee will see this explanation.',
        cancelLabel: 'Cancel',
        cancelAriaLabel: 'Cancel',
        confirmLabel: 'Reject',
        confirmingLabel: 'Rejecting…',
      },
      /**
       * The decision stamp — who decided this request, and when.
       *
       * Every decided request gets one. Before this, the review detail stated
       * its status NOWHERE: an approved request was identifiable only by the
       * ABSENCE of the Approve/Reject buttons and the presence of the monthly
       * note. Absence is not a signal, and a financial decision should name
       * the person who made it.
       *
       * A `paid` request reads "Approved on …" here, because that is the
       * decision this line records; the separate `paid.paidLine` below then
       * adds the payout on top of it. The two are different events by
       * different people and each says so.
       */
      decision: {
        approvedLine: (date: string, email: string) => `Approved on ${date} by ${email}`,
        rejectedLine: (date: string, email: string) => `Rejected on ${date} by ${email}`,
      },
      /** `paid` render branch (T13, specs/20260719-refund-monthly-processing/tasks.md, design.md F4 step 4) — identical to `approved` PLUS this line, MINUS MonthlyProcessingNote. */
      paid: {
        paidLine: (date: string, email: string) => `Paid on ${date} by ${email}`,
      },
      /** The classification panel and the approve refusals (specs/20261118-refund-accounting-export, design S7/S8). */
      classification: {
        legend: 'Classification',
        groupLabel: (line: string) => `Classification for ${line}`,
        account: 'Account',
        vatCode: 'VAT code',
        chooseAccount: 'Choose an account',
        chooseVatCode: 'Choose a VAT code',
        accountOption: (number: string, name: string) => `${number} — ${name}`,
        vatOption: (code: string, label: string, rate: string) => `${code} — ${label} (${rate})`,
        inactiveOption: (text: string) => `${text} (inactive)`,
        defaultMarker: 'Default',
        handMarker: 'Set by hand',
        required: 'Required to approve.',
        missingAccount: 'Choose an account.',
        missingVatCode: 'Choose a VAT code.',
        inactiveCurrentAccount: 'This account is deactivated. The line keeps it; choose an active one to change it.',
        inactiveCurrentVat: 'This VAT code is deactivated. The line keeps it; choose an active one to change it.',
        rate: 'Exchange rate',
        rateValue: (rate: string, month: string) => `${rate} · ${month}`,
        rateMissing: 'Rate missing',
        rateMissingHelp: (currency: string, month: string) =>
          `No ${currency} rate for ${month}. The CHF and VAT amounts need it.`,
        openRates: 'Open exchange rates',
        chfAmount: 'CHF amount',
        vatAmount: 'VAT amount',
        vatAmountValue: (amount: string, rate: string) => `${amount} (${rate})`,
        unavailable: '—',
        follows: 'Amounts follow the approved total as it stands now.',
        saving: 'Saving…',
        savedAccount: (text: string) => `Account set to ${text}`,
        savedVat: (text: string) => `VAT code set to ${text}`,
        saveError: 'Could not change the classification. Try again.',
        forbidden: "You don't have permission to change this classification.",
        accountInactive: 'That account was deactivated. Choose another.',
        vatInactive: 'That VAT code was deactivated. Choose another.',
        locked: 'Locked: its batch has been paid.',
        readOnly: 'You can view the classification but not change it.',
        selfRestricted: "You can't classify your own request. Someone else has to do it.",
        outOfScope: 'Not shown: this line is outside your entity scope. Ask a colleague with WellD CH access.',
        lineOutOfScope: "This line is outside your entity scope, so you can't change it.",
        loading: 'Loading classification…',
        loadError: 'Could not load the classification.',
        unavailable404: 'The classification is not available for this request.',
        lockedGuardrail: {
          title: 'This line is locked',
          message: 'Its batch has been paid, so the classification can no longer change.',
        },
        missingSummary: {
          title: (n: number) =>
            n === 1
              ? 'Nothing was approved. 1 value needs your attention.'
              : `Nothing was approved. ${n} values need your attention.`,
          hint: 'Choose the missing values, then approve again.',
          account: (line: string) => `${line}: choose an account`,
          vatCode: (line: string) => `${line}: choose a VAT code`,
          outOfScope: (line: string) => `${line}: needs a colleague with WellD CH access`,
        },
        releasePending:
          'Approvals are not available yet: the accounting setup has not been completed. Ask an administrator.',
        /** specs/20261119-accounting RS4: Accounting cannot be read (AC-6.5, UX-19). */
        accountingUnavailablePage: {
          title: 'Accounting cannot be read now',
          body: 'Each line is shown as recorded. Classification cannot be changed until Accounting can be read.',
        },
        accountingUnavailableLine: 'Accounting cannot be read now, so this classification cannot be changed.',
        defaultRecorded: 'Default (as recorded)',
        notFoundOption: (text: string) => `${text} (not in Accounting)`,
        notFoundCurrentAccount: 'This account is no longer in Accounting. The line keeps it; choose another to change it.',
        notFoundCurrentVat: 'This VAT code is no longer in Accounting. The line keeps it; choose another to change it.',
        /** `what` is "account" or "VAT code". */
        defaultDeactivated: (what: string) => `The default ${what} for this type is deactivated in Accounting. Choose one.`,
        defaultNotFound: (what: string) => `The default ${what} for this type is no longer in Accounting. Choose one.`,
        /** The rate fact before approval (UX-20): approval is not refused for a missing rate. */
        rateNotYet: 'No rate yet',
        rateNotYetHelp: (currency: string, month: string) =>
          `No ${currency} rate for ${month} yet. You can still approve: the rate is copied at the first export.`,
        /** The rate fact after approval, with no copied rate (AC-5.6). */
        ratePending: 'Rate pending',
        ratePendingHelp: (currency: string, month: string) =>
          `No ${currency} rate for ${month} yet. It is copied at the first accounting export of the batch.`,
        frozen: 'Account, VAT code and rate are kept as booked. Later changes in Accounting do not change this line.',
        askManager: 'Ask an accounting manager to enter or fetch it.',
        accountUnknown: 'That account is no longer in Accounting. Choose another.',
        vatUnknown: 'That VAT code is no longer in Accounting. Choose another.',
      },
    },
    notFound: {
      heading: 'Page not found',
      body: 'This refund section doesn’t exist. Use the navigation above to pick My requests or Review queue.',
    },
    /** Screen B1 (T13, specs/20260719-refund-monthly-processing/tasks.md, design.md F8). Replaces T9's placeholder. */
    batchHistory: {
      heading: 'Monthly processing',
      newBatchButton: 'Compile new batch',
      loadingAnnouncement: 'Loading batch history',
      loadErrorFallback: 'Could not load batch history.',
      empty: {
        heading: 'No compilations yet.',
        body: 'Compile your first monthly batch to get started.',
      },
      row: {
        openLabel: (cutoff: string, status: string) => `Open batch, cutoff ${cutoff}, ${status}`,
        cutoffLabel: (date: string) => `Cutoff: ${date}`,
        countLabel: (count: number) => `${count} request${count === 1 ? '' : 's'}`,
      },
    },
    /** Screen B2 (T11, specs/20260719-refund-monthly-processing/tasks.md, design.md F1/Screen B2). */
    compileBatch: {
      heading: 'Compile a new batch',
      cancelLink: 'Cancel',
      cutoffLabel: 'Cutoff',
      cutoffHelp: 'Defaults to the current moment — requests approved after this point are not included.',
      previewButton: 'Preview',
      loadingAnnouncement: 'Loading candidates',
      loadErrorFallback: 'Could not load the candidate set.',
      /** The compile-empty-set refusal (AC-1.4) — a real, successful, empty result, not an error. */
      empty: {
        heading: 'Nothing to compile',
        body: 'No approved, unbatched requests are eligible as of this cutoff.',
      },
      /** Title of the preview's batch-total card (INC-33). */
      totalsHeading: 'Batch total',
      /** Warning modal shown when a preview returns an empty candidate set — so an empty result is unmissable, not a silent muted line. */
      emptyWarning: {
        title: 'Nothing to compile',
        message:
          'There are no approved, unbatched requests eligible as of this cutoff. Approve requests in the review queue first, or adjust the cutoff and preview again.',
      },
      compileButton: 'Compile this batch',
      /** Post-compile one-shot confirmation, carried to Screen B3 via the `confirmation` search param (design.md F1 step 6). */
      successConfirmation: (count: number) => `Batch compiled — ${count} request${count === 1 ? '' : 's'}, PDF ready`,
      confirm: {
        title: 'Compile this batch?',
        body: (count: number, cutoff: string) =>
          `Compile ${count} request${count === 1 ? '' : 's'} as of ${cutoff} into a new batch?`,
        confirmLabel: 'Compile',
        confirmingLabel: 'Compiling…',
        /** 422 — a race: the candidate set changed since this screen's last preview (design.md F1 step 6). */
        staleCandidatesError: 'This candidate set changed since you last previewed it. Refresh and try again.',
        genericError: 'Could not compile this batch. Try again.',
      },
    },
    /**
     * Screen B3 (T12, specs/20260719-refund-monthly-processing/tasks.md, design.md
     * F2/F3/F4/F6/Screen B3). Replaces T9's placeholder. Also the email
     * deep-link landing page.
     */
    batchDetail: {
      heading: 'Batch',
      /** Dismiss (×) on the visible one-shot confirmation banner (INC-19). */
      confirmationDismissLabel: 'Dismiss',
      loadingAnnouncement: 'Loading this batch',
      loadErrorFallback: 'Could not load this batch.',
      notFound: {
        heading: 'Batch not found',
        body: 'This batch doesn’t exist.',
        backLink: 'Back to monthly processing',
      },
      /** Title of the batch's summary card (INC-33). */
      summaryHeading: 'Summary',
      meta: {
        cutoffLabel: (date: string) => `Cutoff: ${date}`,
        generatedLabel: (date: string, email: string) => `Generated ${date} by ${email}`,
        /**
         * The batch's own id doubles as its human-facing reference — the same
         * value appears in the accounting email's subject/body
         * (notify-api/src/system/emailTemplates.ts) and on the compiled PDF
         * (refund-api/src/batches/pdf.ts). There is no separate reference
         * number, so the label says what it is FOR rather than just naming it.
         */
        referenceLabel: 'Batch reference',
        referenceTooltip:
          'Quote this when referring to the batch — it appears in the accounting email and on the compiled PDF.',
      },
      /** Email delivery status — shared verbatim by Screen B3's own status line, `MarkPaidDialog`'s FYI line, and Screen B1's compact row indicator. */
      email: {
        sent: 'Email: sent',
        failed: 'Email: failed',
        /**
         * specs/20260722-refund-settings AC-2.2/ADR 20260722-batch-email-recipient-live-resolution-amends-0021 — the accounting
         * distribution email was unset at send/resend time, so refund-api
         * never attempted delivery. Deliberately actionable and distinct
         * from `failed` (an ordinary Resend/notify-api outage): it names the
         * fix and where to make it, not just that something went wrong.
         */
        blocked_unconfigured: 'Email: blocked — set the accounting distribution email in Admin > Refund first.',
        notAttempted: 'Email: not yet attempted',
        resendButton: 'Resend email',
        resendingLabel: 'Resending…',
        resendSuccessToast: 'Email resent',
        resendFailureToast: 'Could not send this email. Try again later.',
      },
      paidLine: (date: string, email: string) => `Paid on ${date} by ${email}`,
      discardedLine: (date: string, email: string) => `Discarded on ${date} by ${email}`,
      /** Shared 409-race message for both Mark-as-paid and Discard — both mean "someone else already closed this batch out" (design.md F4/F6). */
      guardrail: {
        title: 'This batch has already been resolved',
        message: 'This batch has already been resolved and can no longer be changed.',
      },
      markPaid: {
        button: 'Mark as paid',
        confirmation: (count: number) => `Batch marked as paid — ${count} request${count === 1 ? '' : 's'} updated`,
        genericError: 'Could not mark this batch as paid. Try again.',
      },
      discard: {
        button: 'Discard batch',
        entityLabel: 'batch',
        body: (count: number) =>
          `Discard this batch? Its ${count} request${count === 1 ? '' : 's'} will be released and become eligible for a future compilation. The batch’s own record remains visible in history. This cannot be undone.`,
        confirmation: (count: number) => `Batch discarded — ${count} request${count === 1 ? '' : 's'} released`,
        genericError: 'Could not discard this batch. Try again.',
      },
      /** Receipt numbers under a batch request row (design S9). `list` is the numbers, joined by the page. */
      receiptNumbers: (list: string) => `Receipts ${list}`,
      /** The accounting export card (design S10). */
      accountingExport: {
        title: 'Accounting export',
        description:
          'One row per approved WellD CH expense line, with account, VAT and CHF amount, as a CSV file.',
        loading: 'Checking the export…',
        loadError: 'Could not check the export.',
        rows: (n: number) => (n === 1 ? '1 row will be exported.' : `${n} rows will be exported.`),
        headerOnly:
          'There are no approved WellD CH lines in this batch. The file will contain only the header row.',
        excluded: (n: number) =>
          n === 1
            ? '1 WellD Italia line is left out: the export covers WellD CH only.'
            : `${n} WellD Italia lines are left out: the export covers WellD CH only.`,
        download: 'Download CSV',
        downloading: 'Preparing file…',
        downloadLabel: (batchId: string) => `Download the accounting export of batch ${batchId}`,
        downloaded: (n: number) => `Export downloaded: ${n} rows`,
        /** Lines whose exchange rate is copied at this export (AC-5.6, UX-22). */
        pending: (n: number) =>
          n === 1
            ? '1 line gets its exchange rate at this export.'
            : `${n} lines get their exchange rate at this export.`,
        blocked: {
          title: 'The export is blocked',
          /** AC-6.6: its own heading inside the blocked banner, never a missing rate. */
          unavailableTitle: 'Accounting cannot be read',
          unavailableBody:
            'The exchange rates of lines with a pending rate cannot be fetched. You can still pay or discard this batch. Check again in a few minutes.',
          /** Why a rate is missing (G7), after the currency and month. */
          rateReason: {
            notPublished: 'not published yet',
            fetchFailed: 'the official source did not answer',
            noSource: 'no official source',
          },
          intro:
            'The file cannot be produced until the items below are resolved. You can still pay or discard this batch.',
          reason: 'The export is blocked. See the items above.',
          missingRates: 'Missing exchange rates',
          rateItem: (currency: string, month: string) => `${currency} · ${month}`,
          /** A missing rate with the reason the answer carries (G7): `reason` is one of `rateReason`. */
          rateItemReason: (currency: string, month: string, reason: string) => `${currency} · ${month} — ${reason}`,
          askAdmin: 'Ask an administrator to enter or fetch it.',
          fetchTried: 'Accounting just tried to fetch the missing rates from the official source.',
          unclassified: 'Lines without an account or a VAT code',
          unclassifiedItem: (employee: string, receipt: string, missing: string) =>
            `${employee} · ${receipt}: no ${missing}`,
          missingWhat: { account: 'account', vatCode: 'VAT code', both: 'account or VAT code' },
          openRequest: 'Open request',
          unnumbered: 'Lines without a receipt number',
          unnumberedBody: 'Contact an administrator.',
          checkAgain: 'Check again',
          recheckReady: (n: number) =>
            n === 0
              ? 'The export is ready: the file will contain only the header row.'
              : `The export is ready: ${n === 1 ? '1 row' : `${n} rows`}.`,
          recheckBlocked: (n: number) => `Still blocked: ${n === 1 ? '1 item' : `${n} items`}.`,
          turnedBlocked: 'The export became blocked while you were downloading. See the items below.',
        },
        downloadError: 'No file was produced. Try again.',
        denied: 'The accounting export is available to reviewers with WellD CH access.',
        discardedAnnouncement: 'This batch has been discarded; the export is no longer available.',
      },
    },
  },
  components: {
    errorBanner: {
      defaultRetryLabel: 'Retry',
      dismissLabel: 'Dismiss',
    },
    toastBanner: {
      dismissLabel: 'Dismiss',
    },
    skeletonListRows: {
      /** sr-only aria-live loading text a caller composes into its own list-loading announcement. */
      loadingLabel: 'Loading…',
    },
    confirmDeleteModal: {
      /** "Delete {entityLabel}?" — see this file's doc comment on why this is a function. */
      title: (entityLabel: string) => `Delete ${entityLabel}?`,
      cancelLabel: 'Cancel',
      cancelAriaLabel: 'Cancel',
      deleteLabel: 'Delete',
      deletingLabel: 'Deleting…',
      untitledFallback: 'Untitled',
      /** Default body copy when the caller doesn't override `body` — see this file's doc comment. */
      defaultBody: (itemName: string) => `‘${itemName}’ will be permanently deleted. This cannot be undone.`,
    },
    guardrailDialog: {
      defaultAcknowledgeLabel: 'OK',
    },
    permissionDenied: {
      heading: 'You no longer have refund access.',
      body: 'If this is unexpected, contact your administrator.',
    },
    attachmentList: {
      attachButton: 'Attach files',
      removeLabel: (fileName: string) => `Remove ${fileName}`,
      /** Hover tooltip (`title`) on the attachment-remove "×". Post-close amendment (specs/20260716-refund-service, 2026-07-17): removing now opens `removeConfirmTitle`/`removeConfirmBody` — overrides the original no-confirm decision. */
      removeTitle: 'Remove attachment',
      removeConfirmTitle: 'Remove this attachment?',
      removeConfirmEntityLabel: 'attachment',
      removeConfirmBody: (fileName: string) => `“${fileName}” will be removed. This cannot be undone.`,
      removeConfirmError: 'Could not remove this attachment. Try again.',
      downloadLabel: (fileName: string) => `Download ${fileName}`,
      downloadError: 'Could not open this attachment. Try again.',
      dismissLabel: (fileName: string) => `Dismiss ${fileName}`,
      statusQueued: 'Queued',
      statusUploading: 'Uploading…',
      statusStored: 'Uploaded',
      /** INC-19: polite announcements — the file appearing in / leaving the list is the visible confirmation. */
      uploadedAnnouncement: (fileName: string) => `${fileName} uploaded`,
      removedAnnouncement: (fileName: string) => `${fileName} removed`,
      statusFailed: 'Upload failed. Try again.',
      /** Shown when the failure carried a diagnosable cause (an API Problem detail, or the direct-to-bucket POST's own error) instead of collapsing every cause into `statusFailed`. */
      statusFailedDetail: (reason: string) => `Upload failed: ${reason}`,
      /** Phase 2 (the cross-origin POST straight to the storage bucket) produced an opaque network error — offline, or the bucket is missing its CORS rule. See infra/README.md § "Receipt bucket CORS". */
      statusFailedStorage:
        'Upload failed — could not reach file storage. Try again, and tell an administrator if it keeps happening.',
      rejectedTooLarge: 'File exceeds 10 MB and was not added.',
      rejectedType: 'Unsupported file type — use PDF, JPEG, or PNG.',
    },
    /** `BatchSubtotalsPanel` (T10, specs/20260719-refund-monthly-processing/tasks.md) — a one-figure-per-currency card, unlike `SubtotalsPanel`'s requested/approved pair. */
    batchSubtotalsPanel: {
      totalLabel: 'Approved total',
    },
    /** `BatchEmployeeGroupList` (T10, specs/20260719-refund-monthly-processing/tasks.md) — modes `preview`|`detail`. */
    batchEmployeeGroupList: {
      requestCountLabel: (count: number) => `${count} request${count === 1 ? '' : 's'}`,
      /** `detail` mode only — each request row's link, disambiguating a list of otherwise-identical controls (design.md Accessibility). */
      openRequestLabel: (employeeName: string, status: string, amount: string, receipts?: string) =>
        `Open ${employeeName}’s request, ${status}, ${amount}${receipts ? `, receipts ${receipts}` : ''}`,
    },
    /** `BatchPdfLink` (T10, specs/20260719-refund-monthly-processing/tasks.md) — mirrors `attachmentList`'s download states, scoped to a batch's compiled PDF. */
    /**
     * `RequestExportLink` (ADR 20260908-request-archive-export-refund-api-reads-attachment-bytes) — the per-request archive download.
     * Each failure gets its OWN sentence rather than one generic retry
     * message: "too large" and "a receipt is unreadable" need different
     * actions from the person reading them, and a single "try again" would
     * be wrong advice for both.
     */
    requestExportLink: {
      buttonLabel: 'Export PDF',
      downloadLabel: (reference: string) => `Export request ${reference} as an archive PDF, including all receipts`,
      exporting: 'Preparing…',
      genericError: 'Could not export this request. Try again.',
      tooLargeError: 'This request’s receipts are too large to export in one PDF. Ask an administrator.',
      receiptError: 'A receipt could not be read, so no archive was produced. Ask an administrator.',
      notArchivableError: 'Only an approved request can be exported.',
    },
    batchPdfLink: {
      buttonLabel: 'Download PDF',
      downloadLabel: (reference: string) => `Download compiled PDF for batch ${reference}`,
      downloadError: 'Could not open this PDF. Try again.',
      /**
       * Shown in place of the download control when `BatchDetail.pdf` is
       * `null` (OWASP A04 fix round — refund-api's `resolvePdfLink`
       * degrades a render/store failure to `null` rather than failing the
       * whole request). A temporary, retryable state, not an error banner.
       */
      unavailable: 'PDF temporarily unavailable',
    },
    /**
     * `MarkPaidDialog` (T12, specs/20260719-refund-monthly-processing/tasks.md,
     * design.md F4 step 2 + Accessibility) — the irreversible, money-moving
     * confirm. `acknowledgeLabel` is the full commitment sentence, not a
     * terse "Confirm" (design.md: "so a screen-reader user tabbing to it
     * hears the complete commitment they're making, not just a fragment").
     */
    /**
     * `MileageAmountField` (T13, specs/20260720-mileage-rate/tasks.md, design.md
     * "## Screens & states" Screen R2 state table) — the read-only
     * `km × rate = amount` breakdown that replaces Amount/Currency for a
     * `travel_km` line. `breakdown`/`blocked` are functions since their
     * wording depends on runtime values (see this file's own doc comment on
     * why interpolated copy is a function, not a template literal, for a
     * future non-English locale's sake).
     */
    mileageAmountField: {
      label: 'Amount',
      idlePrompt: 'Enter a distance to calculate the amount.',
      calculating: 'Calculating…',
      breakdown: (km: number, rate: string, amount: string) => `${km} km × ${rate} = ${amount}`,
      blocked: (entityLabel: string) => `No mileage rate configured yet for ${entityLabel}.`,
      fetchError: 'Could not calculate the mileage amount. Try again.',
    },
    /**
     * `MotivoSuggestField` (T10/T11, specs/20260811-motivo-autocomplete/tasks.md;
     * design.md "## Copy — every new string, with its key path") — the motivo
     * autocomplete combobox on a `travel_km` line.
     *
     * DELIBERATELY ABSENT, and it must stay that way: there is NO empty-state,
     * "no results", loading, retry or error string in this namespace. AC-1.6
     * ("no list and no error/empty-state message appear") and AC-5.2 ("no error
     * message, banner, or toast is surfaced") forbid those surfaces outright —
     * design.md's S3/S6/S7 all render identically by construction, so there is
     * nothing for such a string to be attached to. Adding one is a spec
     * violation, not a nicety.
     *
     * Entity labels are NOT re-spelt here: the caller passes
     * `strings.badges.entity[…]` into `optionLabel`, the same source
     * `EntityBadge` renders from. Dates come from `lib/dates.ts`'s `formatDate`.
     */
    motivoSuggest: {
      /** Accessible name of the suggestion popup (AC-5.6). */
      listboxLabel: 'Past trips matching what you typed',
      /**
       * sr-only polite announcement of the available count (AC-5.6). Called
       * ONLY when count >= 1 — every other state, including no-match and a
       * failed corpus fetch, announces `''`, because a spoken "no suggestions"
       * would be exactly the empty state AC-1.6 forbids, in the audio channel.
       */
      available: (count: number) => `${count} suggestion${count === 1 ? '' : 's'} available`,
      /** Visible distance on a suggestion row — one of AC-1.7's five facts. */
      km: (km: number) => `${km} km`,
      /**
       * Visible ranking rationale on a suggestion row: AC-2.3's two signals
       * (frequency then recency) as one phrase rather than two loose numbers,
       * so the count ladder down the list reads as the list explaining its own
       * order (AC-1.7).
       */
      usage: (count: number, lastUsed: string) => `Used ${count}× · last ${lastUsed}`,
      /**
       * The option's EXPLICIT accessible name — all five AC-1.7 facts in a form
       * that reads correctly aloud (no `×`/`·`, which screen readers voice
       * inconsistently), and immune to the CSS truncation on the visible motivo
       * line. `entity` is the already-localised entity label, passed in by the
       * caller from `strings.badges.entity`.
       */
      optionLabel: (motivo: string, km: number, entity: string, count: number, lastUsed: string) =>
        `${motivo}, ${km} km, ${entity}, used ${count} ${count === 1 ? 'time' : 'times'}, last used ${lastUsed}`,
    },
    markPaidDialog: {
      title: 'Mark this batch as paid?',
      requestCountLabel: (count: number) => `This batch has ${count} request${count === 1 ? '' : 's'}:`,
      /** Appended to the email-status FYI line only when the batch's last send attempt failed. */
      emailFailedFyi: 'you can still mark this batch paid',
      consequence: (count: number) =>
        `This will mark ${count} request${count === 1 ? '' : 's'} as paid, atomically. This cannot be undone — there is no way to reverse a paid batch.`,
      acknowledgeLabel: 'I confirm these requests have been paid through payroll',
      cancelLabel: 'Cancel',
      cancelAriaLabel: 'Cancel',
      confirmLabel: 'Mark as paid',
      confirmingLabel: 'Marking as paid…',
    },
  },
  badges: {
    requestStatus: {
      draft: 'Draft',
      submitted: 'Awaiting decision',
      approved: 'Approved',
      rejected: 'Rejected',
      paid: 'Paid',
    },
    entity: {
      welld_it: 'WellD Italia',
      welld_ch: 'WellD CH',
    },
    /** `CurrencyBadge`'s label per currency — see `EntityBadge.tsx`'s doc comment on the entity/currency split (specs/20260716-refund-service post-close change). */
    currency: {
      EUR: 'EUR',
      CHF: 'CHF',
      USD: 'USD',
      GBP: 'GBP',
    },
    /** `BatchStatusBadge` (T10, specs/20260719-refund-monthly-processing/tasks.md) — 3 variants matching `BatchStatus` verbatim. */
    batchStatus: {
      compiled: 'Compiled',
      paid: 'Paid',
      discarded: 'Discarded',
    },
  },
}

/** The shape of every catalog — the Italian one is typed against it. */
export type Strings = typeof en

const NO_MOTIVO_FALLBACK_IT = '(senza descrizione)'

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/**
 * The Italian catalog (INC-25): complete, in neutral business Italian — no
 * "tu" — and typed against `en`, so a missing or extra key is a type error and
 * `catalogGaps(en, it)` (strings.parity.test.ts) proves it at runtime too.
 * Product names stay as they are (Rimborsi is the tool's Italian name).
 */
const it: Strings = {
  appTitle: 'Rimborsi',
  units: {
    perKm: (rate: string) => `${rate}/km`,
  },
  nav: {
    landmarkLabel: 'Navigazione rimborsi',
    myRequests: 'Le mie richieste',
    reviewQueue: 'Da approvare',
    monthlyProcessing: 'Elaborazione mensile',
    settings: 'Impostazioni',
  },
  accountingUnavailable: {
    cause: 'I dati di riferimento di Contabilità non sono leggibili in questo momento.',
    approve:
      'I dati di riferimento di Contabilità non sono leggibili in questo momento. Non è stato approvato nulla. Riprovare tra qualche minuto.',
    classify:
      'I dati di riferimento di Contabilità non sono leggibili in questo momento. Non è stata modificata la classificazione. Riprovare tra qualche minuto.',
    save: 'I dati di riferimento di Contabilità non sono leggibili in questo momento. Non è stato salvato nulla. Riprovare tra qualche minuto.',
    options:
      'I dati di riferimento di Contabilità non sono leggibili in questo momento, quindi non ci sono voci tra cui scegliere. Riprovare tra qualche minuto.',
  },
  settings: {
    heading: 'Impostazioni',
    description: 'La tariffa chilometrica di ogni società e l’indirizzo che riceve il lotto mensile.',
    entityRates: (entity: string) => `Tariffe chilometriche · ${entity}`,
    loading: 'Caricamento delle tariffe chilometriche…',
    loadError: 'Impossibile caricare le tariffe chilometriche.',
    forbidden: 'Non si dispone dei permessi per vedere le tariffe chilometriche.',
    forbiddenTitle: 'Nessun accesso alle tariffe chilometriche',
    perKm: (rate: string, currency: string) => `${rate} ${currency}/km`,
    caption: (entity: string) => `Tariffe chilometriche ${entity}`,
    columns: {
      rate: 'Tariffa',
      validFrom: 'Valida dal',
      addedBy: 'Aggiunta da',
      addedOn: 'Aggiunta il',
      status: 'Stato',
    },
    inEffect: 'In vigore',
    addRateEntry: 'Aggiungi tariffa',
    added: (entity: string) => `Tariffa aggiunta per ${entity}`,
    addFailed: 'Impossibile aggiungere questa tariffa. Riprovare.',
    empty: {
      title: 'Ancora nessuna tariffa',
      body: (entity: string) => `Nessuna tariffa ancora configurata per ${entity}.`,
    },
    rateError: 'Inserire una tariffa maggiore di 0.',
    validFromError: 'Inserire una data valida.',
    addDialog: {
      title: (entity: string) => `Aggiungi tariffa — ${entity}`,
      description:
        'Una volta salvata, questa voce non può essere modificata né eliminata: una correzione è sempre una nuova voce.',
      busy: 'Aggiunta…',
      rate: 'Tariffa al km',
      validFrom: 'Valida dal',
      validFromHint: 'Sono accettate date passate, presenti o future.',
      cancel: 'Annulla',
    },
    email: {
      title: 'Email di distribuzione contabilità',
      description: 'L’indirizzo email che riceve ogni lotto mensile di rimborsi. Lasciarlo vuoto per sospendere l’invio.',
      loading: 'Caricamento dell’email di distribuzione contabilità…',
      loadError: 'Impossibile caricare l’email di distribuzione contabilità.',
      saved: 'Email di distribuzione contabilità salvata',
      cleared: 'Email di distribuzione contabilità cancellata',
      currentValue: 'Valore attuale',
      notConfigured: 'Non configurata',
      emailAddress: 'Indirizzo email',
      placeholder: 'contabilita@welld.ch',
      save: 'Salva',
      clear: 'Cancella',
      historyTitle: 'Cronologia delle modifiche',
      historyEmpty: 'Ancora nessuna modifica registrata.',
      historyItem: (value: string, by: string, at: string) => `${value} — ${by} — ${at}`,
    },
    dismiss: 'Chiudi',
    descriptionAll: 'Le tariffe chilometriche e la classificazione predefinita dei tipi di spesa.',
    sections: {
      label: 'Sezioni delle impostazioni',
      general: 'Generale',
      accounting: 'Conti e IVA',
      exchangeRates: 'Tassi di cambio',
      defaults: 'Classificazione predefinita',
    },
    accountingLink: {
      withAccess: 'I conti contabili, i codici IVA e i tassi di cambio sono tenuti nell’app Contabilità.',
      linkText: 'Apri Contabilità',
      linkLabel: 'Apri Contabilità: conti contabili, codici IVA e tassi di cambio',
      withoutAccess:
        'I conti contabili, i codici IVA e i tassi di cambio sono tenuti nell’app Contabilità dai responsabili della contabilità. Se manca una voce, rivolgersi a uno di loro.',
    },
    catalog: {
      status: { active: 'Attivo', inactive: 'Disattivato' },
      forbidden: 'Non si dispone dei permessi per questa operazione.',
      genericError: 'Impossibile salvare. Riprovare.',
      cancel: 'Annulla',
      close: 'Chiudi',
      none: 'Nessuno',
      inactiveTag: 'Disattivato',
    },
    history: {
      title: (subject: string) => `Cronologia — ${subject}`,
      description: 'Tutte le modifiche, dalla più recente.',
      empty: 'Ancora nessuna modifica registrata.',
      columns: { when: 'Quando', by: 'Da', account: 'Conto', vatCode: 'Codice IVA' },
      open: 'Cronologia',
      openLabel: (subject: string) => `Mostra la cronologia di ${subject}`,
      closeLabel: 'Chiudi la cronologia',
    },
    accounts: {
      title: 'Conti contabili',
      description: 'I conti del piano dei conti di WellD CH su cui si possono registrare i rimborsi.',
      caption: 'Conti contabili di WellD CH',
      loading: 'Caricamento dei conti contabili…',
      loadError: 'Impossibile caricare i conti contabili.',
      empty: { title: 'Ancora nessun conto contabile', body: 'Aggiungere i conti su cui si registrano i rimborsi.' },
      columns: { number: 'Numero', name: 'Nome', status: 'Stato', added: 'Aggiunto', actions: 'Azioni' },
      addedBy: (by: string, on: string) => `${by} · ${on}`,
      add: 'Aggiungi conto',
      addDialog: {
        title: 'Aggiungi conto contabile',
        description:
          'Numero e nome non possono essere modificati in seguito. Un conto può essere disattivato e riattivato.',
        number: 'Numero del conto',
        numberHint: 'Per esempio 5905 o 2620.1',
        name: 'Nome del conto',
        busy: 'Aggiunta…',
      },
      errors: {
        numberInvalid: 'Inserire un numero di conto come 5905 o 2620.1.',
        nameRequired: 'Inserire un nome di al massimo 120 caratteri.',
        duplicate: (number: string) => `Il conto ${number} esiste già.`,
        duplicateInactive: (number: string) =>
          `Il conto ${number} esiste già ma è disattivato. Riattivarlo dall’elenco.`,
        alreadyActive: (number: string) => `Il conto ${number} è già attivo.`,
        alreadyInactive: (number: string) => `Il conto ${number} è già disattivato.`,
      },
      added: (number: string) => `Conto ${number} aggiunto`,
      deactivated: (number: string) => `Conto ${number} disattivato`,
      reactivated: (number: string) => `Conto ${number} riattivato`,
      deactivate: 'Disattiva',
      reactivate: 'Riattiva',
      deactivateLabel: (number: string) => `Disattiva il conto ${number}`,
      reactivateLabel: (number: string) => `Riattiva il conto ${number}`,
      deactivateDialog: {
        title: (number: string) => `Disattivare il conto ${number}?`,
        body: 'Non potrà più essere scelto come predefinito né su una riga. Le righe già classificate con questo conto lo mantengono. Un tipo di spesa che lo usa come predefinito resterà senza predefinito finché non se ne sceglie un altro. Si può riattivare in qualsiasi momento.',
        confirm: 'Disattiva',
        busy: 'Disattivazione…',
      },
    },
    vatCodes: {
      title: 'Codici IVA',
      description: 'I codici IVA utilizzabili nei rimborsi. Ognuno ha un’aliquota fissa.',
      caption: 'Codici IVA di WellD CH',
      loading: 'Caricamento dei codici IVA…',
      loadError: 'Impossibile caricare i codici IVA.',
      empty: { title: 'Ancora nessun codice IVA', body: 'Aggiungere i codici IVA utilizzabili nei rimborsi.' },
      columns: {
        code: 'Codice',
        label: 'Descrizione',
        rate: 'Aliquota IVA',
        status: 'Stato',
        added: 'Aggiunto',
        actions: 'Azioni',
      },
      addedBy: (by: string, on: string) => `${by} · ${on}`,
      add: 'Aggiungi codice IVA',
      addDialog: {
        title: 'Aggiungi codice IVA',
        description: 'L’aliquota non può essere modificata in seguito: una nuova aliquota richiede un nuovo codice.',
        code: 'Codice',
        codeHint: 'Lettere, cifre, - e _ (fino a 16). Salvato in maiuscolo.',
        label: 'Descrizione',
        rate: 'Aliquota IVA (%)',
        rateHint: 'Tra 0 e 100, fino a 2 decimali.',
        busy: 'Aggiunta…',
      },
      errors: {
        codeInvalid: 'Inserire un codice di lettere, cifre, - o _ (fino a 16).',
        labelRequired: 'Inserire una descrizione di al massimo 80 caratteri.',
        rateInvalid: 'Inserire un’aliquota tra 0 e 100, con al massimo 2 decimali.',
        duplicate: (code: string) => `Il codice IVA ${code} esiste già.`,
        duplicateInactive: (code: string) =>
          `Il codice IVA ${code} esiste già ma è disattivato. Riattivarlo dall’elenco.`,
        alreadyActive: (code: string) => `Il codice IVA ${code} è già attivo.`,
        alreadyInactive: (code: string) => `Il codice IVA ${code} è già disattivato.`,
      },
      added: (code: string) => `Codice IVA ${code} aggiunto`,
      deactivated: (code: string) => `Codice IVA ${code} disattivato`,
      reactivated: (code: string) => `Codice IVA ${code} riattivato`,
      deactivate: 'Disattiva',
      reactivate: 'Riattiva',
      deactivateLabel: (code: string) => `Disattiva il codice IVA ${code}`,
      reactivateLabel: (code: string) => `Riattiva il codice IVA ${code}`,
      deactivateDialog: {
        title: (code: string) => `Disattivare il codice IVA ${code}?`,
        body: 'Non potrà più essere scelto come predefinito, come codice IVA per le valute estere né su una riga. Le righe già classificate lo mantengono. La sua aliquota non cambia mai. Si può riattivare in qualsiasi momento.',
        confirm: 'Disattiva',
        busy: 'Disattivazione…',
      },
    },
    defaults: {
      title: 'Classificazione predefinita',
      description:
        'Il conto e il codice IVA assegnati a ogni tipo di spesa in WellD CH. La contabilità può cambiarli riga per riga. Dove un tipo non ha un predefinito, la contabilità deve sceglierlo su ogni riga prima di approvare.',
      caption: 'Classificazione predefinita per tipo di spesa',
      loading: 'Caricamento della classificazione predefinita…',
      loadError: 'Impossibile caricare la classificazione predefinita.',
      columns: {
        type: 'Tipo di spesa',
        account: 'Conto predefinito',
        vatCode: 'Codice IVA predefinito',
        changed: 'Ultima modifica',
        actions: 'Azioni',
      },
      notSet: 'Mai impostato',
      state: {
        deactivated: 'Disattivato in Contabilità',
        notFound: 'Non trovato in Contabilità',
      },
      needsChoice: (n: number) =>
        n === 1
          ? '1 predefinito richiede una nuova scelta: la sua voce è disattivata o non più presente in Contabilità. Le righe di quel tipo non hanno un predefinito finché non se ne sceglie un altro.'
          : `${n} predefiniti richiedono una nuova scelta: la loro voce è disattivata o non più presente in Contabilità. Le righe di quei tipi non hanno un predefinito finché non se ne sceglie un altro.`,
      unavailable: {
        title: 'Contabilità non è leggibile in questo momento',
        body: 'I predefiniti sono mostrati come registrati. Non si possono modificare finché Contabilità non è leggibile.',
      },
      changeBlocked: 'Contabilità non è leggibile in questo momento: i predefiniti non si possono modificare.',
      recovered: 'Contabilità è di nuovo leggibile.',
      stillUnavailable: 'Contabilità non è ancora leggibile.',
      changedBy: (by: string, on: string) => `${by} · ${on}`,
      change: 'Modifica',
      changeLabel: (type: string) => `Modifica il predefinito di ${type}`,
      historyLabel: (type: string) => `Mostra la cronologia del predefinito di ${type}`,
      dialog: {
        title: (type: string) => `Classificazione predefinita — ${type}`,
        description: 'Vale per le righe esaminate da ora in poi. Le righe già approvate mantengono quanto hanno.',
        account: 'Conto predefinito',
        vatCode: 'Codice IVA predefinito',
        noneOption: 'Nessuno (nessun predefinito)',
        chooseOption: 'Scegliere…',
        inactiveCurrent: (what: string) =>
          `Il valore attuale (${what}) è disattivato. Sceglierne un altro, oppure nessuno.`,
        inactiveSentence: 'Le righe di questo tipo non hanno un predefinito finché non se ne sceglie un altro.',
        notFoundCurrent: (what: string) =>
          `Il valore attuale (${what}) non è più presente in Contabilità. Sceglierne un altro, oppure nessuno.`,
        tryAgain: 'Riprova',
        save: 'Salva',
        busy: 'Salvataggio…',
      },
      saved: (type: string) => `Predefinito salvato per ${type}`,
      errors: {
        accountInactive: 'Questo conto è stato disattivato. Sceglierne un altro.',
        vatInactive: 'Questo codice IVA è stato disattivato. Sceglierne un altro.',
        accountNotFound: 'Questo conto non è più presente in Contabilità. Sceglierne un altro.',
        vatNotFound: 'Questo codice IVA non è più presente in Contabilità. Sceglierne un altro.',
      },
      foreign: {
        term: 'Codice IVA per le righe in valuta estera',
        description:
          'Le righe WellD CH in una valuta diversa dal CHF ricevono questo codice per impostazione predefinita.',
        none: 'Nessuno designato',
        inactiveWarning: (code: string) =>
          `${code} è disattivato: le righe in valuta estera non hanno un codice IVA finché non se ne designa un altro.`,
        notFoundWarning: (code: string) =>
          `${code} non è più presente in Contabilità: le righe in valuta estera non hanno un codice IVA finché non se ne designa un altro.`,
        dialogTitle: 'Codice IVA per le righe in valuta estera',
        saved: 'Codice IVA per le valute estere salvato',
        historyLabel: 'il codice IVA per le valute estere',
        changeLabel: 'Modifica il codice IVA per le righe in valuta estera',
      },
    },
    fx: {
      title: 'Tassi di cambio mensili',
      description:
        'CHF per 1 unità di valuta estera, media mensile. Usati per l’importo in CHF nell’esportazione contabile.',
      caption: 'Tassi di cambio medi mensili',
      loading: 'Caricamento dei tassi di cambio…',
      loadError: 'Impossibile caricare i tassi di cambio.',
      empty: { title: 'Ancora nessun mese da mostrare', body: 'Nessun mese concluso ha tassi da mostrare.' },
      columns: { month: 'Mese' },
      origin: { fetched: 'Recuperato', corrected: 'Corretto' },
      missing: 'Mancante',
      correct: 'Correggi',
      correctLabel: (currency: string, month: string) => `Correggi il tasso ${currency} di ${month}`,
      cellLabel: (currency: string, month: string, rate: string, origin: string) =>
        `${currency}, ${month}: ${rate}, ${origin}`,
      cellMissingLabel: (currency: string, month: string) => `${currency}, ${month}: mancante`,
      fetchNow: 'Recupera ora',
      fetching: 'Recupero…',
      checking: 'Verifica di nuovi tassi…',
      fetchedOk: (n: number) => (n === 1 ? 'Registrati i tassi di 1 mese.' : `Registrati i tassi di ${n} mesi.`),
      nothingNew: 'Nessun nuovo tasso da registrare.',
      throttled: 'I tassi sono stati controllati poco fa. Riprovare tra qualche minuto.',
      deferred: (n: number) =>
        n === 1
          ? 'Resta ancora 1 mese da recuperare. Recuperare di nuovo per continuare.'
          : `Restano ancora ${n} mesi da recuperare. Recuperare di nuovo per continuare.`,
      fetchError: 'Impossibile recuperare i tassi. Riprovare.',
      notFetchable: (month: string) => `I tassi di ${month} non sono ancora pubblicati.`,
      disabled: 'Il recupero automatico è disattivato in questo ambiente. Inserire i tassi a mano.',
      lastFetch: {
        term: 'Ultimo recupero',
        never: 'Ancora nessun recupero',
        ok: (at: string) => `${at} — riuscito`,
        failed: (at: string) => `${at} — non riuscito`,
        disabled: (at: string) => `${at} — saltato, il recupero automatico è disattivato`,
        notFetchable: (at: string) => `${at} — i tassi non sono ancora pubblicati`,
        throttled: (at: string) => `${at} — saltato, i tassi sono stati controllati poco fa`,
        failedTitle: 'L’ultimo recupero non è riuscito',
        failedBody: (at: string, reason: string) => `Il ${at}: ${reason}. I tassi già registrati non sono cambiati.`,
      },
      reason: {
        timeout: 'la fonte ufficiale non ha risposto in tempo',
        http: 'la fonte ufficiale ha restituito un errore',
        parse: 'non è stato possibile leggere la risposta',
        monthMismatch: 'la risposta riguardava un altro mese',
        currencyMissing: 'mancava una valuta nella risposta',
        unknown: 'si è verificato un errore sconosciuto',
      },
      correction: {
        title: (currency: string, month: string) => `Correggi tasso — ${currency} · ${month}`,
        description:
          'Il valore precedente resta nella cronologia. Un lotto esportato prima di questa correzione darà un risultato diverso se esportato di nuovo.',
        rate: (currency: string) => `Tasso (CHF per 1 ${currency})`,
        inEffect: (rate: string, origin: string) => `In vigore: ${rate} (${origin})`,
        rateInvalid: 'Inserire un tasso maggiore di 0, con al massimo 6 decimali.',
        monthNotCompleted: 'Questo mese non è ancora concluso: il suo tasso non può essere corretto.',
        save: 'Salva correzione',
        busy: 'Salvataggio…',
        saved: (currency: string, month: string) => `Tasso ${currency} di ${month} corretto`,
      },
      history: { rateColumn: 'Tasso', originColumn: 'Origine' },
      historyLabel: (currency: string, month: string) => `il tasso ${currency} di ${month}`,
    },
  },
  pages: {
    myRequests: {
      heading: 'Le mie richieste',
      newRequestButton: 'Nuova richiesta',
      loadingAnnouncement: 'Caricamento delle richieste',
      loadErrorFallback: 'Impossibile caricare le richieste.',
      empty: {
        heading: 'Pronti a inviare la prima nota spese?',
        body: 'Aggiungere le spese, allegare le ricevute e inviare all’amministrazione per l’approvazione, direttamente da qui.',
      },
      confirmationDismissLabel: 'Chiudi',
      row: {
        updatedLabel: (date: string) => `Aggiornata il ${date}`,
        openLabel: (label: string) => `Apri la richiesta aggiornata il ${label}`,
      },
    },
    newRequest: {
      heading: 'Nuova richiesta',
      placeholder: 'La nuova richiesta di rimborso verrà creata qui come bozza.',
      creatingAnnouncement: 'Creazione della richiesta in corso…',
      createError: 'Impossibile creare una nuova richiesta.',
      tryAgain: 'Riprova',
      backToMyRequests: 'Torna alle mie richieste',
    },
    requestDetail: {
      heading: 'Richiesta',
      loadingAnnouncement: 'Caricamento della richiesta',
      loadErrorFallback: 'Impossibile caricare la richiesta.',
      notFound: {
        heading: 'Richiesta non trovata',
        body: 'La richiesta non esiste oppure non si dispone dell’accesso.',
        backLink: 'Torna alle mie richieste',
      },
      composer: {
        heading: 'Aggiungi spesa',
        dateLabel: 'Data',
        typeLabel: 'Tipo di spesa',
        typePlaceholder: 'Selezionare un tipo…',
        motivoLabel: 'Motivo',
        amountLabel: 'Importo richiesto',
        entityLabel: 'Società',
        entityPlaceholder: 'Selezionare una società…',
        currencyLabel: 'Valuta',
        currencyPlaceholder: 'Selezionare una valuta…',
        kmLabel: 'Distanza (km)',
        kmHelp: 'Deve essere maggiore di 0',
        kmFieldAdded: 'Campo chilometri aggiunto: i km sono obbligatori per i viaggi in auto',
        kmFieldRemoved: 'Campo chilometri rimosso: non previsto per questo tipo di spesa',
        addButton: 'Aggiungi spesa',
        addingLabel: 'Aggiunta in corso…',
        genericError: 'Impossibile aggiungere la spesa. Verificare i campi e riprovare.',
        fieldErrors: {
          date: 'Inserire la data della spesa.',
          type: 'Scegliere un tipo di spesa.',
          motivo: 'Inserire un motivo.',
          amount: 'Inserire un importo come 45,50, con al massimo due decimali.',
          entity: 'Scegliere una società.',
          currency: 'Scegliere una valuta.',
          km: 'Inserire una distanza maggiore di 0.',
        },
        suggestionApplied: (motivo: string, km: number, entity: string) =>
          `Compilato da una trasferta precedente: ${motivo}, ${km} km, ${entity}. La data non è cambiata.`,
      },
      lines: {
        emptyDraft: 'Nessuna spesa ancora: aggiungerne una per iniziare.',
        sectionHeading: (count: number) => `Spese (${count})`,
        kmValue: (km: number) => `${km} km`,
        kmWithRate: (km: number, rate: string) => `${km} km × ${rate}`,
        requestedLabel: 'Richiesto',
        approvedLabel: 'Approvato',
        approvedDeltaNote: (requested: string, delta: string) => `richiesto ${requested} · ${delta}`,
        attachmentsIndicator: (count: number) => `${count} ${plural(count, 'file', 'file')}`,
        editButton: 'Modifica',
        deleteButton: 'Elimina',
        doneButton: 'Fatto',
        editLineLabel: (motivo: string) => `Modifica la spesa «${motivo || NO_MOTIVO_FALLBACK_IT}»`,
        editLineTitle: 'Modifica questa spesa',
        doneLabel: (motivo: string) => `Termina la modifica della spesa «${motivo || NO_MOTIVO_FALLBACK_IT}»`,
        doneTitle: 'Richiudi la spesa nel riepilogo',
        deleteLineLabel: (motivo: string) => `Elimina la spesa «${motivo || NO_MOTIVO_FALLBACK_IT}»`,
        deleteLineTitle: 'Elimina questa spesa',
        deleteLineConfirmEntityLabel: 'spesa',
        deleteLineConfirmTitle: 'Eliminare questa spesa?',
        deleteLineConfirmBody: (typeLabel: string, motivo: string) =>
          `«${typeLabel} — ${motivo || NO_MOTIVO_FALLBACK_IT}» verrà eliminata definitivamente. L’operazione non può essere annullata.`,
        savingLabel: 'Salvataggio…',
        updateError: 'Impossibile salvare la modifica. Verificare i campi e riprovare.',
        deleteError: 'Impossibile eliminare la spesa. Riprovare.',
        savedToast: 'Modifiche salvate',
        addedToast: 'Spesa aggiunta',
        deletedToast: 'Spesa eliminata',
        rateAppliedLabel: 'Tariffa applicata',
        rateAppliedValue: (rate: string, validFrom: string) => `${rate} · valida dal ${validFrom}`,
        rejectedBadge: 'Spesa rifiutata',
        rejectionReasonLabel: 'Motivo del rifiuto',
        mileageBlockedAmount: '—',
        receiptNumberLabel: 'Numero ricevuta',
      },
      totalsHeading: 'Totali',
      submit: {
        button: 'Invia per approvazione',
        submittingLabel: 'Invio in corso…',
        blockedNote: 'Aggiungere almeno una spesa prima dell’invio.',
        confirmation: 'Inviata: in attesa della decisione dell’amministrazione',
        genericError: 'Impossibile inviare la richiesta. Riprovare.',
      },
      withdraw: {
        button: 'Ritira',
        withdrawingLabel: 'Ritiro in corso…',
        confirmation: 'Ritirata: di nuovo in bozza',
        guardrailTitle: 'Questa richiesta è già stata decisa',
        guardrailMessage: 'Questa richiesta è già stata decisa e non può più essere ritirata.',
        genericError: 'Impossibile ritirare la richiesta. Riprovare.',
      },
      guardrail: {
        title: 'Questa richiesta è già stata decisa',
        message: 'Questa richiesta è già stata decisa e non può più essere modificata.',
      },
      deleteRequest: {
        button: 'Elimina richiesta',
        entityLabel: 'richiesta',
        body: (lineCount: number) =>
          `Eliminare questa bozza e ${plural(lineCount, 'la sua spesa', `le sue ${lineCount} spese`)}? L’operazione non può essere annullata.`,
        confirmation: 'Bozza eliminata',
        genericError: 'Impossibile eliminare la richiesta. Riprovare.',
      },
      validationSummary: {
        heading: 'Alcune spese vanno corrette prima dell’invio.',
        jumpLinkLabel: (label: string) => `Vai a ${label}`,
        fallbackLineLabel: (lineId: string) => `Spesa ${lineId}`,
        noMotivo: NO_MOTIVO_FALLBACK_IT,
      },
      statusBadges: {
        submittedNote: 'Tutti i campi sono in sola lettura finché la decisione è in sospeso.',
      },
      rejected: {
        motivationHeading: 'Motivo del rifiuto',
        newRequestLink: 'Nuova richiesta',
      },
      paid: {
        paidLine: (date: string) => `Pagata il ${date}`,
      },
      monthlyNote: {
        body: 'I rimborsi approvati vengono pagati insieme, con cadenza mensile. Qui non è indicata una data né un importo di pagamento: per il calendario in vigore rivolgersi all’amministrazione.',
      },
    },
    reviewQueue: {
      heading: 'Da approvare',
      confirmationDismissLabel: 'Chiudi',
      scopeHint: 'Richieste del proprio ambito',
      loadingAnnouncement: 'Caricamento delle richieste da approvare',
      loadErrorFallback: 'Impossibile caricare le richieste da approvare.',
      empty: {
        heading: 'Niente da approvare',
        body: 'Al momento nessuna richiesta attende una decisione.',
      },
      row: {
        openLabel: (employeeName: string, date: string) => `Apri la richiesta di ${employeeName} inviata il ${date}`,
        submittedLabel: (date: string) => `Inviata il ${date}`,
      },
    },
    reviewDetail: {
      heading: 'Verifica richiesta',
      loadingAnnouncement: 'Caricamento della richiesta',
      loadErrorFallback: 'Impossibile caricare la richiesta.',
      requestedByLabel: (owner: { email: string; name: string | null }) =>
        owner.name && owner.name.trim().length > 0
          ? `Richiesta da ${owner.name} (${owner.email})`
          : `Richiesta da ${owner.email}`,
      notFound: {
        heading: 'Richiesta non trovata',
        body: 'La richiesta non esiste oppure non si dispone dell’accesso.',
        backLink: 'Torna alle richieste da approvare',
      },
      guardrail: {
        title: 'Questa richiesta è già stata decisa',
        message: 'Questa richiesta è già stata decisa e non può più essere modificata.',
      },
      approvedTotal: {
        label: 'Totale approvato',
        ariaLabel: (date: string, motivo: string, currency: string) =>
          `Totale approvato per ${date} · ${motivo || NO_MOTIVO_FALLBACK_IT} · ${currency}`,
        savingLabel: 'Salvataggio…',
        updateError: 'Impossibile salvare la modifica. Riprovare.',
        invalidAmount: 'Inserire un importo valido, non negativo.',
      },
      lineReject: {
        rejectButton: 'Rifiuta spesa',
        rejectButtonLabel: (motivo: string) => `Rifiuta la spesa «${motivo || NO_MOTIVO_FALLBACK_IT}»`,
        restoreButton: 'Ripristina spesa',
        restoreButtonLabel: (motivo: string) => `Ripristina la spesa «${motivo || NO_MOTIVO_FALLBACK_IT}»`,
        rejectedBy: (email: string) => `Rifiutata da ${email}`,
        dialogTitle: 'Rifiutare questa spesa?',
        dialogBody: (typeLabel: string, motivo: string, amount: string) =>
          `«${typeLabel} — ${motivo || NO_MOTIVO_FALLBACK_IT}» (${amount}) non verrà rimborsata. Il resto della richiesta resta in verifica ed è possibile ripristinare la spesa finché la richiesta non è decisa.`,
        reasonLabel: 'Motivo del rifiuto',
        reasonHelp: 'Obbligatorio: il dipendente vedrà questa spiegazione.',
        reasonRequired: 'Indicare il motivo del rifiuto della spesa.',
        cancelLabel: 'Annulla',
        closeLabel: 'Chiudi',
        confirmLabel: 'Rifiuta spesa',
        busyLabel: 'Rifiuto in corso…',
        updateError: 'Impossibile aggiornare la spesa. Riprovare.',
      },
      decide: {
        approveButton: 'Approva',
        rejectButton: 'Rifiuta',
        approveConfirmation: (employeeName: string) => `Approvata: richiesta di ${employeeName}`,
        rejectConfirmation: (employeeName: string) => `Rifiutata: richiesta di ${employeeName}`,
        genericError: 'Impossibile registrare la decisione. Riprovare.',
        selfApprovalTooltip: 'Non è possibile approvare una richiesta di rimborso inviata da sé stessi.',
        selfApprovalForbiddenError: 'Non è possibile approvare una richiesta di rimborso inviata da sé stessi.',
        allLinesRejectedTooltip: 'Tutte le spese sono rifiutate: rifiutare invece l’intera richiesta.',
      },
      approveDialog: {
        title: 'Approvare questa richiesta?',
        body: (employeeName: string) =>
          `I totali approvati diventano definitivi alla conferma e ${employeeName} riceve subito una notifica.`,
        confirmLabel: 'Approva',
        confirmingLabel: 'Approvazione in corso…',
      },
      rejectDialog: {
        title: 'Rifiutare questa richiesta?',
        body: (employeeName: string) =>
          `${employeeName} riceve subito una notifica con il motivo indicato sotto. L’operazione non può essere annullata.`,
        motivationLabel: 'Motivo del rifiuto',
        motivationHelp: 'Obbligatorio: il dipendente vedrà questa spiegazione.',
        cancelLabel: 'Annulla',
        cancelAriaLabel: 'Annulla',
        confirmLabel: 'Rifiuta',
        confirmingLabel: 'Rifiuto in corso…',
      },
      decision: {
        approvedLine: (date: string, email: string) => `Approvata il ${date} da ${email}`,
        rejectedLine: (date: string, email: string) => `Rifiutata il ${date} da ${email}`,
      },
      paid: {
        paidLine: (date: string, email: string) => `Pagata il ${date} da ${email}`,
      },
      classification: {
        legend: 'Classificazione',
        groupLabel: (line: string) => `Classificazione per ${line}`,
        account: 'Conto',
        vatCode: 'Codice IVA',
        chooseAccount: 'Scegliere un conto',
        chooseVatCode: 'Scegliere un codice IVA',
        accountOption: (number: string, name: string) => `${number} — ${name}`,
        vatOption: (code: string, label: string, rate: string) => `${code} — ${label} (${rate})`,
        inactiveOption: (text: string) => `${text} (disattivato)`,
        defaultMarker: 'Predefinito',
        handMarker: 'Impostato a mano',
        required: 'Obbligatorio per approvare.',
        missingAccount: 'Scegliere un conto.',
        missingVatCode: 'Scegliere un codice IVA.',
        inactiveCurrentAccount:
          'Questo conto è disattivato. La riga lo mantiene; sceglierne uno attivo per cambiarlo.',
        inactiveCurrentVat:
          'Questo codice IVA è disattivato. La riga lo mantiene; sceglierne uno attivo per cambiarlo.',
        rate: 'Tasso di cambio',
        rateValue: (rate: string, month: string) => `${rate} · ${month}`,
        rateMissing: 'Tasso mancante',
        rateMissingHelp: (currency: string, month: string) =>
          `Nessun tasso ${currency} per ${month}. Servono per gli importi in CHF e IVA.`,
        openRates: 'Apri i tassi di cambio',
        chfAmount: 'Importo in CHF',
        vatAmount: 'Importo IVA',
        vatAmountValue: (amount: string, rate: string) => `${amount} (${rate})`,
        unavailable: '—',
        follows: 'Gli importi seguono il totale approvato attuale.',
        saving: 'Salvataggio…',
        savedAccount: (text: string) => `Conto impostato su ${text}`,
        savedVat: (text: string) => `Codice IVA impostato su ${text}`,
        saveError: 'Impossibile modificare la classificazione. Riprovare.',
        forbidden: 'Non si dispone dei permessi per modificare questa classificazione.',
        accountInactive: 'Questo conto è stato disattivato. Sceglierne un altro.',
        vatInactive: 'Questo codice IVA è stato disattivato. Sceglierne un altro.',
        locked: 'Bloccata: il lotto è stato pagato.',
        readOnly: 'È possibile vedere la classificazione ma non modificarla.',
        selfRestricted: "Non è possibile classificare la propria richiesta. Deve farlo un'altra persona.",
        outOfScope: 'Non visibile: questa riga è fuori dal proprio ambito di entità. Rivolgersi a un collega con accesso a WellD CH.',
        lineOutOfScope: 'Questa riga è fuori dal proprio ambito di entità: non è possibile modificarla.',
        loading: 'Caricamento della classificazione…',
        loadError: 'Impossibile caricare la classificazione.',
        unavailable404: 'La classificazione non è disponibile per questa richiesta.',
        lockedGuardrail: {
          title: 'Questa riga è bloccata',
          message: 'Il suo lotto è stato pagato: la classificazione non può più cambiare.',
        },
        missingSummary: {
          title: (n: number) =>
            n === 1
              ? 'Non è stato approvato nulla. 1 valore richiede attenzione.'
              : `Non è stato approvato nulla. ${n} valori richiedono attenzione.`,
          hint: 'Scegliere i valori mancanti, poi approvare di nuovo.',
          account: (line: string) => `${line}: scegliere un conto`,
          vatCode: (line: string) => `${line}: scegliere un codice IVA`,
          outOfScope: (line: string) => `${line}: serve un collega con accesso a WellD CH`,
        },
        releasePending:
          'Le approvazioni non sono ancora disponibili: la configurazione contabile non è stata completata. Rivolgersi a un amministratore.',
        accountingUnavailablePage: {
          title: 'Contabilità non è leggibile in questo momento',
          body: 'Ogni riga è mostrata come registrata. La classificazione non si può modificare finché Contabilità non è leggibile.',
        },
        accountingUnavailableLine:
          'Contabilità non è leggibile in questo momento: questa classificazione non si può modificare.',
        defaultRecorded: 'Predefinito (come registrato)',
        notFoundOption: (text: string) => `${text} (non presente in Contabilità)`,
        notFoundCurrentAccount:
          'Questo conto non è più presente in Contabilità. La riga lo mantiene; sceglierne un altro per cambiarlo.',
        notFoundCurrentVat:
          'Questo codice IVA non è più presente in Contabilità. La riga lo mantiene; sceglierne un altro per cambiarlo.',
        defaultDeactivated: (what: string) =>
          `Il ${what} predefinito di questo tipo è disattivato in Contabilità. Sceglierne uno.`,
        defaultNotFound: (what: string) =>
          `Il ${what} predefinito di questo tipo non è più presente in Contabilità. Sceglierne uno.`,
        rateNotYet: 'Ancora nessun tasso',
        rateNotYetHelp: (currency: string, month: string) =>
          `Ancora nessun tasso ${currency} per ${month}. Si può comunque approvare: il tasso viene copiato alla prima esportazione.`,
        ratePending: 'Tasso in attesa',
        ratePendingHelp: (currency: string, month: string) =>
          `Ancora nessun tasso ${currency} per ${month}. Viene copiato alla prima esportazione contabile del lotto.`,
        frozen:
          'Conto, codice IVA e tasso restano come registrati. Le modifiche successive in Contabilità non cambiano questa riga.',
        askManager: 'Chiedere a un responsabile della contabilità di inserirlo o recuperarlo.',
        accountUnknown: 'Questo conto non è più presente in Contabilità. Sceglierne un altro.',
        vatUnknown: 'Questo codice IVA non è più presente in Contabilità. Sceglierne un altro.',
      },
    },
    notFound: {
      heading: 'Pagina non trovata',
      body: 'Questa sezione di Rimborsi non esiste. Usare la navigazione qui sopra per scegliere Le mie richieste o Da approvare.',
    },
    batchHistory: {
      heading: 'Elaborazione mensile',
      newBatchButton: 'Prepara nuovo lotto',
      loadingAnnouncement: 'Caricamento dello storico dei lotti',
      loadErrorFallback: 'Impossibile caricare lo storico dei lotti.',
      empty: {
        heading: 'Ancora nessun lotto.',
        body: 'Preparare il primo lotto mensile per iniziare.',
      },
      row: {
        openLabel: (cutoff: string, status: string) => `Apri il lotto, data limite ${cutoff}, ${status}`,
        cutoffLabel: (date: string) => `Data limite: ${date}`,
        countLabel: (count: number) => `${count} ${plural(count, 'richiesta', 'richieste')}`,
      },
    },
    compileBatch: {
      heading: 'Prepara un nuovo lotto',
      cancelLink: 'Annulla',
      cutoffLabel: 'Data limite',
      cutoffHelp: 'Per impostazione predefinita è il momento attuale: le richieste approvate dopo non vengono incluse.',
      previewButton: 'Anteprima',
      loadingAnnouncement: 'Caricamento delle richieste candidate',
      loadErrorFallback: 'Impossibile caricare le richieste candidate.',
      empty: {
        heading: 'Niente da includere',
        body: 'Nessuna richiesta approvata e non ancora in un lotto è idonea a questa data limite.',
      },
      totalsHeading: 'Totale del lotto',
      emptyWarning: {
        title: 'Niente da includere',
        message:
          'Nessuna richiesta approvata e non ancora in un lotto è idonea a questa data limite. Approvare prima le richieste in Da approvare, oppure modificare la data limite e rifare l’anteprima.',
      },
      compileButton: 'Prepara questo lotto',
      successConfirmation: (count: number) =>
        `Lotto preparato: ${count} ${plural(count, 'richiesta', 'richieste')}, PDF pronto`,
      confirm: {
        title: 'Preparare questo lotto?',
        body: (count: number, cutoff: string) =>
          `Includere ${count} ${plural(count, 'richiesta', 'richieste')} alla data limite ${cutoff} in un nuovo lotto?`,
        confirmLabel: 'Prepara',
        confirmingLabel: 'Preparazione in corso…',
        staleCandidatesError: 'Le richieste candidate sono cambiate dall’ultima anteprima. Aggiornare e riprovare.',
        genericError: 'Impossibile preparare il lotto. Riprovare.',
      },
    },
    batchDetail: {
      heading: 'Lotto',
      confirmationDismissLabel: 'Chiudi',
      loadingAnnouncement: 'Caricamento del lotto',
      loadErrorFallback: 'Impossibile caricare il lotto.',
      notFound: {
        heading: 'Lotto non trovato',
        body: 'Questo lotto non esiste.',
        backLink: 'Torna all’elaborazione mensile',
      },
      summaryHeading: 'Riepilogo',
      meta: {
        cutoffLabel: (date: string) => `Data limite: ${date}`,
        generatedLabel: (date: string, email: string) => `Generato il ${date} da ${email}`,
        referenceLabel: 'Riferimento lotto',
        referenceTooltip:
          'Indicarlo quando ci si riferisce al lotto: compare nell’email all’amministrazione e nel PDF del lotto.',
      },
      email: {
        sent: 'Email: inviata',
        failed: 'Email: non riuscita',
        blocked_unconfigured:
          'Email: bloccata. Impostare prima l’indirizzo di distribuzione dell’amministrazione in Admin > Rimborsi.',
        notAttempted: 'Email: non ancora inviata',
        resendButton: 'Invia di nuovo l’email',
        resendingLabel: 'Invio in corso…',
        resendSuccessToast: 'Email inviata di nuovo',
        resendFailureToast: 'Impossibile inviare l’email. Riprovare più tardi.',
      },
      paidLine: (date: string, email: string) => `Pagato il ${date} da ${email}`,
      discardedLine: (date: string, email: string) => `Annullato il ${date} da ${email}`,
      guardrail: {
        title: 'Questo lotto è già stato chiuso',
        message: 'Questo lotto è già stato chiuso e non può più essere modificato.',
      },
      markPaid: {
        button: 'Segna come pagato',
        confirmation: (count: number) =>
          `Lotto segnato come pagato: ${count} ${plural(count, 'richiesta aggiornata', 'richieste aggiornate')}`,
        genericError: 'Impossibile segnare il lotto come pagato. Riprovare.',
      },
      discard: {
        button: 'Annulla lotto',
        entityLabel: 'lotto',
        body: (count: number) =>
          `Annullare questo lotto? ${plural(count, 'La sua richiesta verrà rilasciata e potrà', `Le sue ${count} richieste verranno rilasciate e potranno`)} essere incluse in un lotto futuro. Il lotto resta visibile nello storico. L’operazione non può essere annullata.`,
        confirmation: (count: number) =>
          `Lotto annullato: ${count} ${plural(count, 'richiesta rilasciata', 'richieste rilasciate')}`,
        genericError: 'Impossibile annullare il lotto. Riprovare.',
      },
      receiptNumbers: (list: string) => `Ricevute ${list}`,
      accountingExport: {
        title: 'Esportazione contabile',
        description:
          'Una riga per ogni spesa WellD CH approvata, con conto, IVA e importo in CHF, in un file CSV.',
        loading: 'Verifica dell’esportazione…',
        loadError: 'Impossibile verificare l’esportazione.',
        rows: (n: number) => (n === 1 ? 'Verrà esportata 1 riga.' : `Verranno esportate ${n} righe.`),
        headerOnly:
          'Nel lotto non ci sono righe WellD CH approvate. Il file conterrà solo la riga di intestazione.',
        excluded: (n: number) =>
          n === 1
            ? '1 riga WellD Italia è esclusa: l’esportazione riguarda solo WellD CH.'
            : `${n} righe WellD Italia sono escluse: l’esportazione riguarda solo WellD CH.`,
        download: 'Scarica CSV',
        downloading: 'Preparazione del file…',
        downloadLabel: (batchId: string) => `Scarica l’esportazione contabile del lotto ${batchId}`,
        downloaded: (n: number) => `Esportazione scaricata: ${n} righe`,
        pending: (n: number) =>
          n === 1
            ? '1 riga riceve il tasso di cambio con questa esportazione.'
            : `${n} righe ricevono il tasso di cambio con questa esportazione.`,
        blocked: {
          title: 'L’esportazione è bloccata',
          unavailableTitle: 'Contabilità non è leggibile',
          unavailableBody:
            'I tassi di cambio delle righe con tasso in attesa non si possono recuperare. Il lotto può comunque essere pagato o scartato. Verificare di nuovo tra qualche minuto.',
          rateReason: {
            notPublished: 'non ancora pubblicato',
            fetchFailed: 'la fonte ufficiale non ha risposto',
            noSource: 'nessuna fonte ufficiale',
          },
          intro:
            'Il file non può essere prodotto finché le voci seguenti non sono risolte. Il lotto può comunque essere pagato o scartato.',
          reason: 'L’esportazione è bloccata. Vedere le voci qui sopra.',
          missingRates: 'Tassi di cambio mancanti',
          rateItem: (currency: string, month: string) => `${currency} · ${month}`,
          rateItemReason: (currency: string, month: string, reason: string) => `${currency} · ${month} — ${reason}`,
          askAdmin: 'Chiedere a un amministratore di inserirlo o recuperarlo.',
          fetchTried: 'Contabilità ha appena provato a recuperare i tassi mancanti dalla fonte ufficiale.',
          unclassified: 'Righe senza conto o senza codice IVA',
          unclassifiedItem: (employee: string, receipt: string, missing: string) =>
            `${employee} · ${receipt}: manca ${missing}`,
          missingWhat: { account: 'il conto', vatCode: 'il codice IVA', both: 'il conto o il codice IVA' },
          openRequest: 'Apri richiesta',
          unnumbered: 'Righe senza numero di ricevuta',
          unnumberedBody: 'Rivolgersi a un amministratore.',
          checkAgain: 'Verifica di nuovo',
          recheckReady: (n: number) =>
            n === 0
              ? "L'esportazione è pronta: il file conterrà solo la riga di intestazione."
              : `L'esportazione è pronta: ${n === 1 ? '1 riga' : `${n} righe`}.`,
          recheckBlocked: (n: number) => `Ancora bloccata: ${n === 1 ? '1 elemento' : `${n} elementi`}.`,
          turnedBlocked: 'L’esportazione si è bloccata durante il download. Vedere le voci seguenti.',
        },
        downloadError: 'Nessun file è stato prodotto. Riprovare.',
        denied: 'L’esportazione contabile è disponibile ai revisori con accesso a WellD CH.',
        discardedAnnouncement: 'Questo lotto è stato scartato: l’esportazione non è più disponibile.',
      },
    },
  },
  components: {
    errorBanner: {
      defaultRetryLabel: 'Riprova',
      dismissLabel: 'Chiudi',
    },
    toastBanner: {
      dismissLabel: 'Chiudi',
    },
    skeletonListRows: {
      loadingLabel: 'Caricamento…',
    },
    confirmDeleteModal: {
      title: (entityLabel: string) => `Eliminare: ${entityLabel}?`,
      cancelLabel: 'Annulla',
      cancelAriaLabel: 'Annulla',
      deleteLabel: 'Elimina',
      deletingLabel: 'Eliminazione…',
      untitledFallback: 'Senza titolo',
      defaultBody: (itemName: string) =>
        `«${itemName}» verrà eliminato definitivamente. L’operazione non può essere annullata.`,
    },
    guardrailDialog: {
      defaultAcknowledgeLabel: 'OK',
    },
    permissionDenied: {
      heading: 'Non si dispone più dell’accesso a Rimborsi.',
      body: 'Se non è previsto, contattare l’amministratore.',
    },
    attachmentList: {
      attachButton: 'Allega file',
      removeLabel: (fileName: string) => `Rimuovi ${fileName}`,
      removeTitle: 'Rimuovi allegato',
      removeConfirmTitle: 'Rimuovere questo allegato?',
      removeConfirmEntityLabel: 'allegato',
      removeConfirmBody: (fileName: string) => `«${fileName}» verrà rimosso. L’operazione non può essere annullata.`,
      removeConfirmError: 'Impossibile rimuovere l’allegato. Riprovare.',
      downloadLabel: (fileName: string) => `Scarica ${fileName}`,
      downloadError: 'Impossibile aprire l’allegato. Riprovare.',
      dismissLabel: (fileName: string) => `Chiudi ${fileName}`,
      statusQueued: 'In coda',
      statusUploading: 'Caricamento…',
      statusStored: 'Caricato',
      uploadedAnnouncement: (fileName: string) => `${fileName} caricato`,
      removedAnnouncement: (fileName: string) => `${fileName} rimosso`,
      statusFailed: 'Caricamento non riuscito. Riprovare.',
      statusFailedDetail: (reason: string) => `Caricamento non riuscito: ${reason}`,
      statusFailedStorage:
        'Caricamento non riuscito: archivio file non raggiungibile. Riprovare e, se il problema persiste, avvisare un amministratore.',
      rejectedTooLarge: 'Il file supera i 10 MB e non è stato aggiunto.',
      rejectedType: 'Tipo di file non supportato: usare PDF, JPEG o PNG.',
    },
    batchSubtotalsPanel: {
      totalLabel: 'Totale approvato',
    },
    batchEmployeeGroupList: {
      requestCountLabel: (count: number) => `${count} ${plural(count, 'richiesta', 'richieste')}`,
      openRequestLabel: (employeeName: string, status: string, amount: string, receipts?: string) =>
        `Apri la richiesta di ${employeeName}, ${status}, ${amount}${receipts ? `, ricevute ${receipts}` : ''}`,
    },
    requestExportLink: {
      buttonLabel: 'Esporta PDF',
      downloadLabel: (reference: string) =>
        `Esporta la richiesta ${reference} in un PDF d’archivio, con tutte le ricevute`,
      exporting: 'Preparazione…',
      genericError: 'Impossibile esportare la richiesta. Riprovare.',
      tooLargeError:
        'Le ricevute di questa richiesta sono troppo grandi per un unico PDF. Rivolgersi a un amministratore.',
      receiptError:
        'Una ricevuta non è leggibile, quindi l’archivio non è stato prodotto. Rivolgersi a un amministratore.',
      notArchivableError: 'Si può esportare solo una richiesta approvata.',
    },
    batchPdfLink: {
      buttonLabel: 'Scarica PDF',
      downloadLabel: (reference: string) => `Scarica il PDF del lotto ${reference}`,
      downloadError: 'Impossibile aprire il PDF. Riprovare.',
      unavailable: 'PDF temporaneamente non disponibile',
    },
    mileageAmountField: {
      label: 'Importo',
      idlePrompt: 'Inserire una distanza per calcolare l’importo.',
      calculating: 'Calcolo in corso…',
      breakdown: (km: number, rate: string, amount: string) => `${km} km × ${rate} = ${amount}`,
      blocked: (entityLabel: string) => `Nessuna tariffa chilometrica ancora configurata per ${entityLabel}.`,
      fetchError: 'Impossibile calcolare l’importo chilometrico. Riprovare.',
    },
    motivoSuggest: {
      listboxLabel: 'Trasferte precedenti che corrispondono al testo inserito',
      available: (count: number) => `${count} ${plural(count, 'suggerimento disponibile', 'suggerimenti disponibili')}`,
      km: (km: number) => `${km} km`,
      usage: (count: number, lastUsed: string) => `Usata ${count}× · ultima ${lastUsed}`,
      optionLabel: (motivo: string, km: number, entity: string, count: number, lastUsed: string) =>
        `${motivo}, ${km} km, ${entity}, usata ${count} ${plural(count, 'volta', 'volte')}, ultima volta il ${lastUsed}`,
    },
    markPaidDialog: {
      title: 'Segnare questo lotto come pagato?',
      requestCountLabel: (count: number) =>
        `Questo lotto contiene ${count} ${plural(count, 'richiesta', 'richieste')}:`,
      emailFailedFyi: 'è comunque possibile segnare il lotto come pagato',
      consequence: (count: number) =>
        `${plural(count, 'La richiesta verrà segnata', `Le ${count} richieste verranno segnate`)} come ${plural(count, 'pagata', 'pagate')}, in un’unica operazione. L’operazione non può essere annullata: un lotto pagato non si può ripristinare.`,
      acknowledgeLabel: 'Confermo che queste richieste sono state pagate con la busta paga',
      cancelLabel: 'Annulla',
      cancelAriaLabel: 'Annulla',
      confirmLabel: 'Segna come pagato',
      confirmingLabel: 'Registrazione del pagamento…',
    },
  },
  badges: {
    requestStatus: {
      draft: 'Bozza',
      submitted: 'In attesa di decisione',
      approved: 'Approvata',
      rejected: 'Rifiutata',
      paid: 'Pagata',
    },
    entity: {
      welld_it: 'WellD Italia',
      welld_ch: 'WellD CH',
    },
    currency: {
      EUR: 'EUR',
      CHF: 'CHF',
      USD: 'USD',
      GBP: 'GBP',
    },
    batchStatus: {
      compiled: 'Preparato',
      paid: 'Pagato',
      discarded: 'Annullato',
    },
  },
}

/** Both catalogs, for the parity test and for a test that renders in Italian. */
export const catalogs = { en, it }

/**
 * The active catalog: the person's language, resolved ONCE by the library
 * (`resolveLocale`: the shell's `<html lang>`, else the browser), English when
 * neither is Italian. Every call site reads `strings.foo.bar`.
 */
export const strings: Strings = selectStrings({ en, it })
