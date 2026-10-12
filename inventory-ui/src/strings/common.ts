/**
 * strings.common — copy for the shared primitives (T25, specs/015-hardware-
 * inventory): ErrorBanner, PermissionDenied, SkeletonListRows, ConfirmDialog,
 * GuardrailDialog, FormModal and the entity / currency chips. Ported from
 * refund-ui's `components` and `badges` strings, reworded for this tool.
 */
export const common = {
  errorBanner: {
    defaultRetryLabel: 'Retry',
    dismissLabel: 'Dismiss',
  },
  /** The 503 fail-closed variant of ErrorBanner (design.md § Screens & states). */
  authUnavailable: {
    heading: 'Authorization service unavailable',
    body: 'We cannot verify your access right now. Nothing was changed.',
  },
  permissionDenied: {
    heading: 'You do not have access to this section.',
    body: 'If this is unexpected, contact your administrator.',
  },
  skeletonListRows: {
    /** sr-only aria-live loading text a caller composes into its own list-loading announcement. */
    loadingLabel: 'Loading…',
  },
  confirmDialog: {
    /** "Delete {entityLabel}?" — a function so the noun stays caller-supplied. */
    title: (entityLabel: string) => `Delete ${entityLabel}?`,
    cancelLabel: 'Cancel',
    cancelAriaLabel: 'Cancel',
    deleteLabel: 'Delete',
    deletingLabel: 'Deleting…',
    untitledFallback: 'Untitled',
    /** Default body copy when the caller does not override `body`. */
    defaultBody: (itemName: string) => `‘${itemName}’ will be permanently deleted. This cannot be undone.`,
  },
  supplierField: {
    /** Announced when the suggestion list opens or changes. */
    suggestions: (n: number) => (n === 1 ? '1 supplier suggestion available' : `${n} supplier suggestions available`),
  },
  guardrailDialog: {
    defaultAcknowledgeLabel: 'OK',
  },
  formModal: {
    cancelLabel: 'Cancel',
    closeAriaLabel: 'Close',
    defaultSubmitLabel: 'Save',
    defaultSubmittingLabel: 'Saving…',
  },
  entity: {
    welld_it: 'WellD Italia',
    welld_ch: 'WellD CH',
  },
  currency: {
    EUR: 'EUR',
    CHF: 'CHF',
  },
} as const
