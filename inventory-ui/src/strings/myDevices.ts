/**
 * strings.myDevices — the employee devices view D1 (T31, specs/015-hardware-
 * inventory; design.md § D1, F14, Q3 as resolved). No money copy lives here by
 * design (AC-4.2): the view shows no price, book value or entity.
 */
export const myDevices = {
  heading: 'My devices',
  loading: 'Loading your devices',

  pendingHeading: (count: number) => `Waiting for your confirmation (${count})`,
  heldHeading: (count: number) => `Devices I hold (${count})`,
  heldEmpty: 'You do not hold any devices yet.',
  /** Nothing assigned and nothing waiting. Plain text in the page flow, not an alert. */
  empty: 'You have no devices assigned to you, and nothing is waiting for your confirmation.',

  card: {
    offered: (date: string) => `offered ${date}`,
    assigned: (date: string) => `assigned ${date}`,
    confirm: 'I have received this device',
    confirming: 'Confirming…',
    decline: 'Decline',
    /** Appended, visually hidden, so the action is named with the device (design § Accessibility D1). */
    forDevice: (description: string) => `– ${description}`,
    confirmFailed: 'We could not record your confirmation. Try again.',
  },

  /** Polite status line after an action. */
  confirmed: (description: string) => `Confirmed: ${description}`,
  declined: (description: string) => `Declined: ${description}`,

  /** 404 / `assignment_not_pending` on a card that went stale: the list is refreshed. */
  noLongerOpen: 'This assignment is no longer open. The list has been refreshed.',

  declineDialog: {
    entityLabel: 'assignment',
    title: (description: string) => `Decline ${description}?`,
    body: 'You are telling the inventory manager that you did not receive this device. It goes back to stock.',
    confirm: 'Decline device',
    confirming: 'Declining…',
    failed: 'We could not decline this device. Try again.',
  },
} as const
