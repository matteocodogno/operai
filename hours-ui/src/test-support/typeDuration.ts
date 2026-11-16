import userEvent from '@testing-library/user-event'

/**
 * The entry dialog's Duration is typed text (specs/20261112-time-tracking T45, D53): clears what is in the
 * field, then types `text` as a person would. Nothing typed (`''`) leaves it empty.
 */
export const typeDuration = async (field: HTMLElement, text: string): Promise<void> => {
  await userEvent.clear(field)
  if (text !== '') await userEvent.type(field, text)
}
