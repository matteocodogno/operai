# @operai/refund-ui

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

- 98adacd: Surface the real cause when a receipt upload fails instead of collapsing every
  failure into "Upload failed. Try again.". An opaque `fetch` rejection (the
  signature of a storage bucket missing its CORS rule) now reads differently from
  an API Problem response, and the raw error is logged to the console.
