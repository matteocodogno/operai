/**
 * strings — the single source of every user-facing string in refund-ui
 * (T14, specs/007-refund-service/tasks.md: "src/strings.ts: a centralized
 * strings module holding ALL user-facing copy in English for v1 … so NO
 * hardcoded UI strings appear in JSX").
 *
 * Gate-2 decision (ADR candidate — see this task's implementation report):
 * design.md's Gap #1 flags that no i18n mechanism is selected anywhere in
 * plan.md, despite CLAUDE.md's "no hardcoded strings … use constants or i18n
 * from day one (IT/EN at minimum)" mandate. This file makes the pragmatic
 * call for v1: centralize every string here (so no component ever inlines
 * JSX text) but ship ENGLISH ONLY — no i18n *library* (react-i18next or
 * similar), no runtime locale switch. The shape below is deliberately
 * structured so a second locale is a mechanical addition later, not a
 * rewrite:
 *
 *   - Every string lives under a stable, namespaced key path (`nav.myRequests`,
 *     `pages.myRequests.heading`, …) rather than being a flat list or template
 *     literal — the same key path a `Record<Locale, Strings>` dictionary would
 *     need per locale.
 *   - `Strings` (the inferred type of `en`) is exported so a future `it`
 *     object can be typed against it and a `useStrings()`/`getStrings(locale)`
 *     seam introduced without touching every call site (which already reads
 *     `strings.foo.bar`, not `en.foo.bar`).
 *
 * This intentionally does NOT solve i18n — it solves "no hardcoded strings"
 * today while leaving the actual bilingual rollout (library choice, locale
 * detection/switch, the Italian translations themselves) as a follow-up the
 * ADR should name explicitly.
 *
 * Scope note: only the foundation-level strings this task's placeholder
 * screens need are defined here (app title, the two nav labels, one heading +
 * one body line per placeholder screen, the not-found fallback). T15–T18 add
 * their own screens' copy to this same file as they're built — this file
 * grows with the feature, it is not meant to be "complete" yet.
 *
 * T15 addition (specs/007-refund-service/tasks.md: "ported shared components
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
 * T17/T18 addition (specs/007-refund-service/tasks.md): `components.
 * attachmentList` (upload/download copy shared by `AttachmentList`'s draft
 * mode and `AttachmentDownloadLink`'s read-only mode), and the real
 * `pages.reviewQueue`/`pages.reviewDetail` (Screens A1/A2, replacing T14's
 * placeholders). `NO_MOTIVO_FALLBACK` is hoisted above `en` (not inlined
 * per-use) so the same "(no description)" wording the submit-validation
 * summary (T16) already uses is also reused by the approved-total input's
 * disambiguating `aria-label` — a literal object can't reference its own
 * other branches while being built.
 */

const NO_MOTIVO_FALLBACK = '(no description)'

/**
 * ownerDisplay — the single place that resolves a request owner's display
 * name, guarding against `owner.name` being `null` (QE-verified defect,
 * specs/007-refund-service: `refund-api` never populates `RefundRequest.
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
  nav: {
    landmarkLabel: 'Refund navigation',
    myRequests: 'My requests',
    reviewQueue: 'Review queue',
    monthlyProcessing: 'Monthly processing',
  },
  pages: {
    myRequests: {
      heading: 'My requests',
      newRequestButton: '+ New request',
      loadingAnnouncement: 'Loading your requests',
      loadErrorFallback: 'Could not load your requests.',
      empty: {
        heading: 'Ready to submit your first expense request?',
        body: 'Add expense lines, attach receipts, and submit for accounting to review — right from here.',
      },
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
        addButton: '+ Add expense line',
        addingLabel: 'Adding…',
        genericError: 'Could not add this expense line. Check the fields and try again.',
      },
      lines: {
        emptyDraft: 'No expense lines yet — add one to get started.',
        /** Heading above the committed-lines list (post-close UX amendment, specs/007, 2026-07-17): "Expense lines (N)". */
        sectionHeading: (count: number) => `Expense lines (${count})`,
        requestedLabel: 'Requested',
        approvedLabel: 'Approved',
        /** "N files"/"1 file" — the collapsed summary row's small attachment indicator (post-close amendment, specs/007). */
        attachmentsIndicator: (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`,
        editButton: 'Edit',
        deleteButton: 'Delete',
        doneButton: 'Done',
        editLineLabel: (motivo: string) => `Edit line “${motivo || NO_MOTIVO_FALLBACK}”`,
        editLineTitle: 'Edit this expense line',
        doneLabel: (motivo: string) => `Done editing line “${motivo || NO_MOTIVO_FALLBACK}”`,
        doneTitle: 'Collapse this expense line back to a summary',
        deleteLineLabel: (motivo: string) => `Delete line “${motivo || NO_MOTIVO_FALLBACK}”`,
        /** Hover tooltip (`title`) on the summary row's Delete button. Post-close amendment (specs/007, 2026-07-17): deleting a committed line now opens `deleteLineConfirmTitle`/`deleteLineConfirmBody` — overrides the original no-confirm decision. */
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
      },
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
        newRequestLink: '+ New request',
      },
      /** `paid` render branch (T13, specs/008-refund-monthly-processing/tasks.md, design.md F5) — sibling to draft/submitted/approved/rejected. */
      paid: {
        paidLine: (date: string) => `Paid on ${date}`,
      },
      monthlyNote: {
        heading: 'Monthly processing',
        body: 'Approved reimbursements are processed together on a regular monthly cycle. No specific date or payout amount is promised here — check with accounting for the current schedule.',
      },
    },
    reviewQueue: {
      heading: 'Review queue',
      scopeHint: 'Showing requests for your scope',
      loadingAnnouncement: 'Loading the review queue',
      loadErrorFallback: 'Could not load the review queue.',
      empty: 'Nothing awaiting your decision right now.',
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
      decide: {
        approveButton: 'Approve',
        rejectButton: 'Reject',
        approveConfirmation: (employeeName: string) => `Approved — ${employeeName}’s request`,
        rejectConfirmation: (employeeName: string) => `Rejected — ${employeeName}’s request`,
        genericError: 'Could not record this decision. Try again.',
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
        body: (employeeName: string) => `${employeeName} is notified immediately, with the reason below. This cannot be undone.`,
        motivationLabel: 'Reason for rejection',
        motivationHelp: 'Required — the employee will see this explanation.',
        cancelLabel: 'Cancel',
        cancelAriaLabel: 'Cancel',
        confirmLabel: 'Reject',
        confirmingLabel: 'Rejecting…',
      },
      /** `paid` render branch (T13, specs/008-refund-monthly-processing/tasks.md, design.md F4 step 4) — identical to `approved` PLUS this line, MINUS MonthlyProcessingNote. */
      paid: {
        paidLine: (date: string, email: string) => `Paid on ${date} by ${email}`,
      },
    },
    notFound: {
      heading: 'Page not found',
      body: 'This refund section doesn’t exist. Use the navigation above to pick My requests or Review queue.',
    },
    /** Screen B1 (T13, specs/008-refund-monthly-processing/tasks.md, design.md F8). Replaces T9's placeholder. */
    batchHistory: {
      heading: 'Monthly processing',
      newBatchButton: '+ Compile new batch',
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
    /** Screen B2 (T11, specs/008-refund-monthly-processing/tasks.md, design.md F1/Screen B2). */
    compileBatch: {
      heading: 'Compile a new batch',
      cancelLink: 'Cancel',
      cutoffLabel: 'Cutoff',
      cutoffHelp: 'Defaults to the current moment — requests approved after this point are not included.',
      previewButton: 'Preview',
      loadingAnnouncement: 'Loading candidates',
      loadErrorFallback: 'Could not load the candidate set.',
      /** The compile-empty-set refusal (AC-1.4) — a real, successful, empty result, not an error. */
      empty: 'No approved, unbatched requests are eligible as of this cutoff.',
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
     * Screen B3 (T12, specs/008-refund-monthly-processing/tasks.md, design.md
     * F2/F3/F4/F6/Screen B3). Replaces T9's placeholder. Also the email
     * deep-link landing page.
     */
    batchDetail: {
      heading: 'Batch',
      loadingAnnouncement: 'Loading this batch',
      loadErrorFallback: 'Could not load this batch.',
      notFound: {
        heading: 'Batch not found',
        body: 'This batch doesn’t exist.',
        backLink: 'Back to monthly processing',
      },
      meta: {
        cutoffLabel: (date: string) => `Cutoff: ${date}`,
        generatedLabel: (date: string, email: string) => `Generated ${date} by ${email}`,
        referenceLabel: 'Reference',
      },
      /** Email delivery status — shared verbatim by Screen B3's own status line, `MarkPaidDialog`'s FYI line, and Screen B1's compact row indicator. */
      email: {
        sent: 'Email: Sent',
        failed: 'Email: Failed',
        notAttempted: 'Email: Not yet attempted',
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
      defaultBody: (itemName: string) =>
        `‘${itemName}’ will be permanently deleted. This cannot be undone.`,
    },
    guardrailDialog: {
      defaultAcknowledgeLabel: 'OK',
    },
    permissionDenied: {
      heading: 'You no longer have refund access.',
      body: 'If this is unexpected, contact your administrator.',
    },
    attachmentList: {
      attachButton: '+ Attach files',
      removeLabel: (fileName: string) => `Remove ${fileName}`,
      /** Hover tooltip (`title`) on the attachment-remove "×". Post-close amendment (specs/007, 2026-07-17): removing now opens `removeConfirmTitle`/`removeConfirmBody` — overrides the original no-confirm decision. */
      removeTitle: 'Remove attachment',
      removeConfirmTitle: 'Remove this attachment?',
      removeConfirmBody: (fileName: string) => `“${fileName}” will be removed. This cannot be undone.`,
      removeConfirmError: 'Could not remove this attachment. Try again.',
      downloadLabel: (fileName: string) => `Download ${fileName}`,
      downloadError: 'Could not open this attachment. Try again.',
      dismissLabel: (fileName: string) => `Dismiss ${fileName}`,
      statusQueued: 'Queued',
      statusUploading: 'Uploading…',
      statusStored: 'Uploaded',
      statusFailed: 'Upload failed. Try again.',
      rejectedTooLarge: 'File exceeds 10 MB and was not added.',
      rejectedType: 'Unsupported file type — use PDF, JPEG, or PNG.',
    },
    /** `BatchSubtotalsPanel` (T10, specs/008-refund-monthly-processing/tasks.md) — a one-figure-per-currency card, unlike `SubtotalsPanel`'s requested/approved pair. */
    batchSubtotalsPanel: {
      totalLabel: 'Approved total',
    },
    /** `BatchEmployeeGroupList` (T10, specs/008-refund-monthly-processing/tasks.md) — modes `preview`|`detail`. */
    batchEmployeeGroupList: {
      groupAriaLabel: (employeeName: string) => `${employeeName}’s requests`,
      requestCountLabel: (count: number) => `${count} request${count === 1 ? '' : 's'}`,
      /** `detail` mode only — each request row's link, disambiguating a list of otherwise-identical controls (design.md Accessibility). */
      openRequestLabel: (employeeName: string, status: string, amount: string) =>
        `Open ${employeeName}’s request, ${status}, ${amount}`,
    },
    /** `BatchPdfLink` (T10, specs/008-refund-monthly-processing/tasks.md) — mirrors `attachmentList`'s download states, scoped to a batch's compiled PDF. */
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
     * `MarkPaidDialog` (T12, specs/008-refund-monthly-processing/tasks.md,
     * design.md F4 step 2 + Accessibility) — the irreversible, money-moving
     * confirm. `acknowledgeLabel` is the full commitment sentence, not a
     * terse "Confirm" (design.md: "so a screen-reader user tabbing to it
     * hears the complete commitment they're making, not just a fragment").
     */
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
    /** `CurrencyBadge`'s label per currency — see `EntityBadge.tsx`'s doc comment on the entity/currency split (specs/007 post-close change). */
    currency: {
      EUR: 'EUR',
      CHF: 'CHF',
      USD: 'USD',
      GBP: 'GBP',
    },
    /** `BatchStatusBadge` (T10, specs/008-refund-monthly-processing/tasks.md) — 3 variants matching `BatchStatus` verbatim. */
    batchStatus: {
      compiled: 'Compiled',
      paid: 'Paid',
      discarded: 'Discarded',
    },
  },
} as const

/** The shape of `en` — a future second locale is typed against this. */
export type Strings = typeof en

/**
 * The active dictionary. English-only for v1 (see this file's doc comment) —
 * every call site reads `strings.foo.bar` rather than `en.foo.bar` so a
 * future `getStrings(locale)` seam can replace this constant without
 * touching call sites.
 */
export const strings: Strings = en
