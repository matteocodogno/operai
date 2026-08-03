# @operai/shell

## 0.0.1

### Patch Changes

- 6a13795: The shell footer/About dialog was showing `@operai/shell`'s own package
  version (`0.0.0`) instead of the Operai suite's umbrella version — the two
  are different numbers, and only the umbrella one is meaningful to a user.
  The footer now reads the umbrella version from a committed, generated file
  (`shell/src/lib/suiteVersion.generated.json`, kept in sync by
  `scripts/version.mjs` at release time) instead of `shell`'s own
  `package.json`.

  The About dialog additionally gains a "Components" section listing each
  mounted remote's own version (EstimAI, Refund, Admin, Notify), each exposed
  via a small new federated `./version` module. A remote whose version can't be
  resolved — unreachable, cold-starting, or (going forward, since every app
  deploys independently) simply predating this change — degrades to a muted
  "—" rather than blocking the dialog or throwing.

- 590047b: Add the receipt-bucket origin (`https://t3.storageapi.dev`) to the shell CSP's
  `connect-src`. Receipt uploads POST directly to the object-storage bucket
  (ADR-0016), so that request is governed by the shell's CSP even though no
  Operai service is involved — without this pin the browser blocks every upload
  before it leaves the page, regardless of the bucket's CORS rule.
- 09025ee: Serve the SPA document with `Cache-Control: no-store`. CSP rides on a response
  header and a `304 Not Modified` does not carry it, so a browser holding a
  cached copy kept enforcing a stale policy — which left receipt uploads blocked
  for two days after the CSP fix was live and correct. `max-age=0,
must-revalidate` is not sufficient; it still permits the 304.
