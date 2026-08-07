/**
 * strings — the single source of every NEW user-facing string introduced by
 * estimate sharing (T14, specs/013-estimate-sharing/tasks.md: "every new
 * user-facing string from design.md's i18n table lands in `strings.ts` with
 * namespaced keys, typed so a second locale is mechanical").
 *
 * Scope note (plan.md "### Frontend" / design.md "## i18n"): this file holds
 * ONLY the copy this feature adds. estimai-ui's large existing surface
 * (EstimatorApp, ActivityTable, ParametersPanel, …) still inlines its English
 * strings directly in JSX — retro-fitting that pre-existing copy into this
 * file is explicitly out of scope here. CLAUDE.md's "no hardcoded strings …
 * IT/EN at minimum" mandate stays unmet suite-wide (no runtime locale switch
 * exists anywhere in Operai yet); that is an existing, unresolved gap this
 * feature does not silently absorb, matching plan.md's own stated posture.
 *
 * Shape follows the `refund-ui/src/strings.ts` precedent (specs/007 Gate-2):
 * every string lives under a stable, namespaced key path rather than a flat
 * list, and `Strings` (the inferred type of `en`) is exported so a future
 * `it` object — and a `getStrings(locale)` seam — can be introduced later
 * without touching call sites, which already read `strings.foo.bar`, never
 * `en.foo.bar`. A handful of entries are FUNCTIONS rather than plain
 * strings, because their exact wording depends on a runtime value (an email,
 * a name, an access level) and, for a future non-English locale, word order
 * around that interpolation can differ by language — the same reasoning
 * `refund-ui/src/strings.ts` documents for its own interpolated entries.
 *
 * design.md's "IT" column is carried alongside "EN" in this file's source
 * comments/tests only where useful for translators; the *shipped* dictionary
 * (`strings`/`en`) is English-only for v1, exactly like `refund-ui`'s.
 */

const en = {
  sharing: {
    toolbar: {
      shareLink: 'Share link',
      shareLinkCopied: 'Copied!',
      collaborators: 'Collaborators',
      collaboratorsWithCount: (n: number) => `Collaborators (${n})`,
      sharedByChip: (owner: string, level: string) => `Shared by ${owner} · ${level}`,
    },
    dialog: {
      title: 'Collaborators',
      ownerRowLabel: 'You (owner)',
      emailLabel: 'Email',
      emailPlaceholder: 'colleague@welld.ch',
      levelLabel: 'Access level',
      levelViewer: 'Viewer',
      levelViewerHint: 'Can view and export, not edit',
      levelEditor: 'Editor',
      levelEditorHint: 'Can edit like you — except manage collaborators or delete',
      addButton: 'Add collaborator',
      addingButton: 'Adding…',
      emptyState: 'No collaborators yet. Add a colleague by email above.',
      removeAction: (email: string) => `Remove ${email}`,
      removeConfirmTitle: 'Remove collaborator?',
      removeConfirmBody: (email: string) => `${email} will lose access to this estimate immediately.`,
      removeConfirmButton: 'Remove',
      addedAnnouncement: (email: string, level: string) => `${email} added as ${level}`,
      removedAnnouncement: (email: string) => `${email} removed`,
      levelChangedAnnouncement: (email: string, level: string) => `${email}'s access changed to ${level}`,
      leaveAction: 'Leave this estimate',
      leaveConfirmTitle: 'Leave this estimate?',
      leaveConfirmBody: 'You will lose access immediately and it will disappear from your estimates list.',
      leaveConfirmButton: 'Leave',
      sharedWithYouBy: (owner: string) => `Shared with you by ${owner}`,
      yourAccessLevel: (level: string) => `Your access: ${level}`,
    },
    errors: {
      notEligible:
        "That address can't be added as a collaborator. Collaborators must be Operai users who already have EstimAI access.",
      alreadyCollaborator: (level: string) => `Already a collaborator (${level}). → Update their access below instead.`,
      cannotShareWithSelf: "You can't add yourself as a collaborator on your own estimate.",
      rateLimited: 'Too many attempts. Try again in a few minutes.',
      authUnavailable: "Can't check eligibility right now. Try again shortly.",
      invalidEmail: 'Enter a valid email address.',
      genericAddFailed: 'Could not add this collaborator. Try again.',
      genericRemoveFailed: 'Could not remove this collaborator. Try again.',
      genericLevelChangeFailed: "Could not update this collaborator's access. Try again.",
      loadFailed: 'Could not load collaborators.',
      genericLeaveFailed: 'Could not leave this estimate. Try again.',
    },
    identity: {
      deleted: 'Former wellD member',
      unknown: 'Unknown wellD member',
    },
    emptyActivitiesViewer: 'No activities in this estimate yet.',
  },
  conflict: {
    title409: (name: string) => `${name} saved changes to this estimate since you opened it.`,
    title409Unknown: 'Someone else saved changes to this estimate since you opened it.',
    title428: 'This tab needs to reload to keep saving your changes here.',
    reassurance: 'Your edits below are safe and still visible — nothing has been overwritten.',
    reloadButton: 'Reload latest',
    saveAsCopyButton: 'Save as a copy instead',
    savingSuspended: 'Not saving — reload to continue',
  },
  estimatesList: {
    accessEditor: 'Editor',
    accessViewer: 'Viewer',
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
