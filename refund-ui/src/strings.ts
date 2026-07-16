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

const en = {
  appTitle: 'Refund (Rimborsi)',
  nav: {
    landmarkLabel: 'Refund navigation',
    myRequests: 'My requests',
    reviewQueue: 'Review queue',
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
        requestedLabel: 'Requested',
        approvedLabel: 'Approved',
        deleteLineLabel: (motivo: string) => `Delete line “${motivo}”`,
        savingLabel: 'Saving…',
        updateError: 'Could not save this change. Check the fields and try again.',
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
      requestedByLabel: (name: string, email: string) => `Requested by ${name} (${email})`,
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
    },
    notFound: {
      heading: 'Page not found',
      body: 'This refund section doesn’t exist. Use the navigation above to pick My requests or Review queue.',
    },
  },
  components: {
    errorBanner: {
      defaultRetryLabel: 'Retry',
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
  },
  badges: {
    requestStatus: {
      draft: 'Draft',
      submitted: 'Awaiting decision',
      approved: 'Approved',
      rejected: 'Rejected',
    },
    entity: {
      welld_it: 'WellD Italia · EUR',
      welld_ch: 'WellD CH · CHF',
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
