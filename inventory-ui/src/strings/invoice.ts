/**
 * strings.invoice — the Invoice panel of the asset detail page (T35,
 * specs/015-hardware-inventory; design.md § T2 invoice region, F8, § Error and
 * conflict catalogue, § Accessibility "Invoice panel"). Error messages for
 * 413 / 415 / `upload_not_found` / `invoice_ref_mismatch` are the catalogue's
 * (`strings.errors`); only the panel's own copy lives here.
 */
export const invoice = {
  heading: 'Invoice',

  reference: 'Invoice reference',
  referenceNone: 'Not set',
  file: 'Invoice file',
  fileNone: 'No invoice file yet.',

  open: 'Open invoice',
  /** The accessible name names the file: "Open invoice inv.pdf". */
  openNamed: (fileName: string) => `Open invoice ${fileName}`,
  opening: 'Opening…',
  openFailed: 'Could not open the invoice. Try again.',

  upload: 'Upload invoice',
  uploadAnother: 'Upload a new file',
  uploadAnotherHint: 'A new file replaces the one linked to this asset.',
  /** Why Upload is not available; the `aria-describedby` target. */
  needsReference: 'Set an invoice reference first. Use Edit details, then upload the file.',
  uploading: (fileName: string) => `Uploading ${fileName}…`,
  saved: (fileName: string) => `Invoice file ${fileName} saved.`,
  /** A rejected file stays on screen next to its reason until dismissed. */
  rejected: (fileName: string, reason: string) => `${fileName}: ${reason}`,
  dismiss: 'Dismiss',

  /** The file is stored but the link to THIS asset failed. */
  linkOwnFailed: 'The file was uploaded but could not be linked to this asset.',
  retryLink: 'Try linking again',
  retry: 'Retry',

  readOnly: 'This asset has been disposed of. Its invoice can no longer be changed.',

  siblings: {
    loading: 'Looking for assets with the same invoice reference…',
    failed: 'Could not look up other assets with this invoice reference.',
    legend: (reference: string) => `Link to assets with invoice reference ${reference}`,
    /** A checkbox label: the description, with the serial number when there is one. */
    option: (description: string, serialNumber: string | null) =>
      serialNumber === null ? description : `${description} (${serialNumber})`,
    selected: (count: number) => `${count} selected`,
    link: 'Link selected',
    linking: 'Linking…',
    notNow: 'Not now',
    done: (count: number) => `Invoice linked to ${count} more ${count === 1 ? 'asset' : 'assets'}.`,
    /** Fallback name for an asset the lookup did not return. */
    unnamedAsset: 'An asset',
    /** `asset_disposed` carries the asset id; the catalogue message is prefixed with its name. */
    disposed: (asset: string, message: string) => `${asset}: ${message}`,
    notFound: 'One of the selected assets is no longer available. The list has been refreshed.',
  },
} as const
