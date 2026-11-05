/** Copy for the text card (F7, US-3, AC-3.4): paste or type the meeting as text. */
const en = {
  title: 'Meeting text',
  label: 'Meeting text',
  hint: "Paste or type the notes or transcript. It becomes the meeting's transcript, in passages without times.",
  /** The live counter under the field; both numbers are already formatted. */
  count: (used: string, max: string) => `${used} of ${max} characters`,
  errors: {
    empty: 'Enter the text to save',
    tooLong: (max: string) => `The text is longer than ${max} characters`,
  },
  save: 'Save text',
  saving: 'Saving…',
}

const it: typeof en = {
  title: 'Testo della riunione',
  label: 'Testo della riunione',
  hint: 'Incolla o scrivi gli appunti o la trascrizione. Diventa la trascrizione della riunione, in brani senza orari.',
  count: (used: string, max: string) => `${used} di ${max} caratteri`,
  errors: {
    empty: 'Inserisci il testo da salvare',
    tooLong: (max: string) => `Il testo supera i ${max} caratteri`,
  },
  save: 'Salva testo',
  saving: 'Salvataggio…',
}

export const text = { en, it }
