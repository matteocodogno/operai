/**
 * strings.actions — the asset detail page's action region (T33, specs/015-
 * hardware-inventory; design.md F3, F5, § Dialogs, § Error and conflict
 * catalogue): the status actions, the pending-assignment and holder-deleted
 * callouts, and the Assign dialog. Templates with `{name}` placeholders go
 * through `fillTemplate`; the API-code messages live in `strings.errors`.
 */
export const actions = {
  groupLabel: 'Asset actions',

  receive: 'Mark as received',
  assign: 'Assign...',
  repair: 'Mark in repair',
  repairDone: 'Repair finished',
  return: 'Record return',
  lost: 'Mark lost',
  found: 'Mark found',

  /** Polite status line after a successful action. */
  done: {
    received: 'Marked as received.',
    assigned: (name: string) => `Assignment offered. Awaiting confirmation from ${name}.`,
    cancelled: 'Assignment cancelled.',
    returned: 'Return recorded.',
    repair: 'Marked in repair.',
    repairDone: 'Repair finished.',
    lost: 'Marked as lost.',
    found: 'Marked as found.',
  },

  /** Who `assignment_pending` names: the race means the page does not know the assignee yet. */
  someone: 'another person',
  /** `invalid_transition` when the server sent no `from`. */
  changedGeneric: 'This asset was changed by someone else. The page has been refreshed.',
  conflictTitle: 'This asset changed',

  pending: {
    cancel: 'Cancel assignment',
    /** "Awaiting confirmation from Anna Rossi, offered 06.10.2026, 3 days ago". */
    text: (name: string, date: string, age: string) => `Awaiting confirmation from ${name}, offered ${date}, ${age}`,
    textNoAge: (name: string, date: string) => `Awaiting confirmation from ${name}, offered ${date}`,
    ageToday: 'today',
    ageDays: (days: number) => (days === 1 ? '1 day ago' : `${days} days ago`),
  },

  holderDeleted: {
    named: (name: string) => `${name}'s account was deleted. Record the return to put this asset back in stock.`,
    unnamed: "The holder's account was deleted. Record the return to put this asset back in stock.",
  },

  returnDialog: {
    entityLabel: 'return',
    title: (description: string) => `Record the return of ${description}?`,
    body: (holder: string) => `${holder} is no longer recorded as the holder, and the asset goes back in stock.`,
    holderFallback: 'The holder',
    confirm: 'Record return',
    confirming: 'Recording…',
  },

  lostDialog: {
    entityLabel: 'asset',
    title: (description: string) => `Mark ${description} as lost?`,
    body: 'Lost assets stay on the books. The holder is cleared and is not restored by Mark found.',
    confirm: 'Mark lost',
    confirming: 'Marking…',
  },

  cancelDialog: {
    entityLabel: 'assignment',
    title: (description: string) => `Cancel the assignment of ${description}?`,
    body: (name: string) =>
      `${name} will no longer be asked to confirm this device. The asset stays in stock with no holder and can be assigned again.`,
    confirm: 'Cancel assignment',
    confirming: 'Cancelling…',
  },

  assignDialog: {
    title: 'Assign asset',
    description: (asset: string) =>
      `${asset} is offered to the person you pick. It stays in stock until they confirm they received it.`,
    holder: 'Holder',
    holderPlaceholder: 'Search by name or email',
    loading: 'Loading users…',
    empty: 'No active users match',
    submit: 'Assign',
    submitting: 'Assigning…',
    retry: 'Retry',
    /** The "name, email, entity" of an option. */
    optionDetail: (email: string, entity: string | null) => (entity === null ? email : `${email}, ${entity}`),
    optionNoName: 'Unnamed user',
  },
} as const
