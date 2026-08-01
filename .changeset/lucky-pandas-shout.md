---
"@operai/shell": patch
---

Add the receipt-bucket origin (`https://t3.storageapi.dev`) to the shell CSP's
`connect-src`. Receipt uploads POST directly to the object-storage bucket
(ADR-0016), so that request is governed by the shell's CSP even though no
Operai service is involved — without this pin the browser blocks every upload
before it leaves the page, regardless of the bucket's CORS rule.
