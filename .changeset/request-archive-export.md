---
"@operai/refund-api": minor
"@operai/refund-ui": minor
---

An approved expense request can now be exported as a single archive PDF —
every expense line with its mileage-rate provenance, plus every receipt
embedded in full. A PDF receipt is copied page-for-page; a JPEG or PNG is
embedded as an image. An "Export PDF" button appears on an approved request
for its owner and for accounting reviewers.

This is the first time refund-api reads attachment bytes at all (ADR-0043).
Receipts were previously reachable only through presigned URLs the browser
followed itself, which is still how receipt downloads work — but an archive
cannot embed a file it may not read. The exposure is bounded: a request whose
receipts exceed the export budget is refused with a clear message rather than
archived incompletely, and a receipt that cannot be embedded fails the whole
export instead of producing a PDF with a silent gap in it. An archive that
looks complete but isn't is worse than one that refuses to build.

Drafts, submitted and rejected requests are not exportable — their figures are
not yet final. Paid requests are, since paying one does not make it less
worth archiving.
