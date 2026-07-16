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
 */

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
      placeholder:
        'Your refund requests will appear here once expense request composition ships.',
    },
    newRequest: {
      heading: 'New request',
      placeholder: 'Starting a new refund request will draft it here.',
    },
    requestDetail: {
      heading: 'Request detail',
      placeholder: 'This request’s expense lines and status will appear here.',
    },
    reviewQueue: {
      heading: 'Review queue',
      placeholder: 'Requests awaiting your decision will be listed here.',
    },
    reviewDetail: {
      heading: 'Review detail',
      placeholder: 'This request’s full detail and decision actions will appear here.',
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
