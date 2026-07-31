---
"@operai/refund-ui": patch
---

Surface the real cause when a receipt upload fails instead of collapsing every
failure into "Upload failed. Try again.". An opaque `fetch` rejection (the
signature of a storage bucket missing its CORS rule) now reads differently from
an API Problem response, and the raw error is logged to the console.
