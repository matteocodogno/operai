# 0030 — Suite version surfacing: generated in-tree file for the umbrella version, federated `./version` export per remote

**Date:** 2026-08-03  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

The suite versions itself with Changesets: independent per-app SemVer plus an aggregate
`operai` umbrella version bumped by the largest per-app bump each release. Today
`shell/vite.config.ts` reads its own `./package.json` via `readFileSync(new
URL('./package.json', import.meta.url))` and bakes it in as `__APP_VERSION__`, which the
footer renders as `Operai v{APP_VERSION}` — but that is the **shell's own** package
version, not the umbrella `operai` version the suite actually releases under. Every app
in the monorepo also deploys with its build root pinned to its own directory (Vercel
Root Directory / Railway Root Directory), and `infra/README.md` already documents the
team hitting a real failure from a build unexpectedly reaching outside its pinned root on
Railway. Vercel's "include files outside the Root Directory" setting is off by default
and its actual state for the shell's project cannot be confirmed. Most importantly,
CLAUDE.md's own choice of `lerna.json` (not `pnpm-workspace.yaml`/`package.json`
`workspaces`) to enumerate Changesets packages exists specifically so that no app's build
ever needs to know the repo root exists — a mechanism requiring the shell's build to read
`../package.json` would run directly against that design intent, independent of whether
it happens to work today.

Separately, the shell's About modal wants to show each mounted tool's own version. Each
remote (`estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui`) is deployed independently
(ADR-0006), from a separate Vercel project and a separate origin, so the shell can never
assume a remote it loads at runtime was built from the same commit, or even the same
release, as the shell itself.

## Decision

We will surface suite version information two ways, one per problem, both extending
ADR-0006's federation contract.

**Umbrella version → shell, via a generated, committed in-tree file.**
`scripts/version.mjs` writes `shell/src/lib/suiteVersion.generated.json` (`{ "version":
"<umbrella>" }`) in the same step that bumps the root `package.json`'s `version` — one
write site, so the two can never drift between releases. `shell/vite.config.ts`'s
`define: { __APP_VERSION__: ... }` reads this file instead of `../package.json`, using
the exact same same-directory `readFileSync(new URL(..., import.meta.url))` pattern
already used for `./package.json`. This keeps every read the shell's build performs
inside `shell/`'s own tree, unconditionally safe regardless of Root-Directory/"include
files outside" settings on any provider. The file is tracked in git, not gitignored — it
changes exactly when the umbrella version changes, mirroring how per-app `CHANGELOG.md`
files are also generated-but-committed by the same script.

**Per-remote version → shell, via a new federated `./version` export.** Each remote's
`vite.config.ts` reads its own `./package.json` (already proven safe at its own build
root — this is the same pattern the MF shared-singleton `requiredVersion` values already
use) and exposes a tiny new module, `./version`, reporting `REMOTE_VERSION`. The shell's
About modal dynamically imports each mounted remote's `./version` in parallel — mirroring
how a remote's `./App` is already lazily imported elsewhere in the shell — each import
raced against a short timeout and wrapped so a rejection never propagates. A remote whose
promise never resolves (unreachable origin, cold-start timeout, or a remote that
predates this change and has no `./version` export at all) renders as an omitted row or a
muted placeholder; the modal renders immediately with whatever it has and updates each
row independently as its own promise settles — it never throws and never blocks on the
slowest remote. This establishes, for the first time, that **a deployed remote may
predate a shell expectation and must degrade silently rather than break the shell** — the
reusable rule for every future shell↔remote seam, since remotes are independently
deployed from separate origins and the shell can never assume commit-parity with any of
them.

## Options considered

### Option A — Generated in-tree file (umbrella) + federated `./version` export (remotes) (chosen)

Described above.

**Pros:**
- Every read either side of the federation boundary performs stays inside that build's
  own directory tree — no dependency on Root-Directory/"include files outside" settings
  on any provider, on either Vercel or Railway
- Single write site for the umbrella version (`scripts/version.mjs`), so the generated
  file can never drift from the root `package.json` it mirrors
- The version already legitimately requires a rebuild — it only changes at release time,
  alongside a real deploy — so a build-time mechanism has no runtime failure mode to
  design around, unlike a fetched value
- Reuses the suite's one existing pattern for "shell reads something small from a remote
  across the federation seam" (the `shell/session`/`shell/tokens.css` exposes, ADR-0006),
  instead of introducing a second mechanism alongside it
- The graceful-degradation logic the About modal needs (timeout + catch) is not new
  complexity — MF's normal remote-loading failure handling (`RemoteMount`'s existing
  "couldn't load" path) already needs the same shape

**Cons:**
- A generated file is now committed to `shell/`'s tree and must be regenerated by
  `scripts/version.mjs` on every umbrella bump — a manual `package.json` version edit
  that bypasses the script silently leaves it stale
- The timeout-raced dynamic import is a new async failure surface inside a modal that
  previously had none, and needs its own test coverage (reject, timeout, and malformed/
  undefined export are three distinct shapes, not one)
- Extends ADR-0006's `exposes`/`consumes` contract across all four remotes simultaneously,
  not incrementally the way ADR-0009 added a single new remote — every remote's
  `vite.config.ts` and `shell/src/federation/remotes.d.ts` change together

### Option B — Runtime fetch of a `runtime-config.json`-style value for the umbrella version (rejected)

Extend the existing `shell/public/runtime-config.json` pattern (used today for
repointing remote URLs without a rebuild) to also carry the umbrella version, fetched at
runtime instead of baked in at build time.

**Pros:**
- Would let the version footer be corrected without a shell rebuild, if that were ever
  needed
- Reuses an existing runtime-config file rather than introducing a new generated one

**Cons:**
- Adds a network round trip and a loading/failure state to something that should be as
  simple and always-available as a footer string
- `runtime-config.json`'s entire reason to exist is repointing remote URLs *without* a
  rebuild across environments; the suite version has no equivalent requirement — it only
  ever changes at release time, alongside a real deploy, so "avoid a rebuild" buys
  nothing here
- Rejected: a committed build-time file is simpler and has no failure mode to design
  around, for no loss of capability actually needed

### Option C — Shell reads the root `package.json` directly (rejected)

`shell/vite.config.ts` reads `../../package.json` (the umbrella version) instead of a
generated in-tree file.

**Pros:**
- No new generated file, no second write site to keep in sync — one fewer moving part in
  the release script

**Cons:**
- Requires the shell's Vercel build to reach outside its pinned Root Directory; Vercel's
  "include files outside the Root Directory" is off by default and its actual state for
  this project could not be confirmed — this plan treats a cross-directory read as
  unreachable on principle, not merely as an unverified risk
- Directly contradicts the reason `lerna.json` (not `pnpm-workspace.yaml`/`package.json`
  `workspaces`) was chosen to enumerate Changesets packages in the first place: so that no
  app's build would ever need to know the repo root exists
- `infra/README.md` already documents the team hitting exactly this class of failure
  (a build unexpectedly scoped to the repo root) on Railway — strong precedent against
  assuming a parent-directory read is safe on any provider
- Rejected: the thing this ADR exists to avoid.

### Option D — Per-remote static `version.json` fetched over plain HTTP (rejected)

Each remote serves a static `version.json` at its own origin; the shell reads each
remote's version with a plain `fetch()` instead of a federated `./version` import.

**Pros:**
- Avoids pulling in the whole Module Federation remote-entry machinery just to read a
  version string
- Would be more resilient than the chosen approach to a remote whose *app* bundle is
  broken — a static file can still answer with a version even if `remoteEntry.js` itself
  fails to load or evaluate

**Cons:**
- Introduces a second mechanism for "shell reads something small from a remote" alongside
  the one the suite already has (the federated-export pattern used for `shell/session`/
  `shell/tokens.css`) — two patterns to maintain and reason about instead of one
- The graceful-degradation logic (timeout + catch) still has to exist either way, so the
  "avoids MF machinery" benefit does not buy simpler failure handling, only a different
  transport
- Rejected for consistency, in full knowledge of the trade-off: this option would
  genuinely have been more resilient to a remote whose app bundle itself is broken. That
  resilience was judged not worth running a second "shell reads from a remote" mechanism
  in parallel with the established one.

## Consequences

**Positive:**
- The footer and About modal both show what the suite actually shipped: the true
  umbrella `operai` version, not the shell's own incidental package version
- The About modal can show each mounted remote's real deployed version without polling,
  a manual update step, or the shell needing to know a remote's version in advance
- Both mechanisms stay entirely inside each build's own directory tree, so neither is
  exposed to Vercel/Railway Root-Directory misconfiguration — the exact class of failure
  `infra/README.md` already documents the team hitting once

**Negative / trade-offs:**
- `shell/src/lib/suiteVersion.generated.json` is a generated file now committed to the
  tree: a small, real ongoing diff on every release commit, and a value that can go stale
  if `scripts/version.mjs` is ever bypassed (e.g. a hand-edited `package.json` version) —
  there is no runtime check that catches this; the shell will silently show whatever the
  file last said
- The timeout-raced dynamic import in the About modal adds a genuinely new async failure
  surface to a component that previously had none — it needs deliberate test coverage
  for all three degrade paths (import rejects, import times out, export is malformed/
  undefined), not just the happy path
- Extends ADR-0006's exposed-module contract across all four remotes at once, so every
  remote's `vite.config.ts` and the shell's `remotes.d.ts` ambient declarations move
  together for this change, rather than one remote at a time the way ADR-0009 added
  `notify-ui`

**Risks:**
- **Generated file drift.** If a future release path bumps `package.json`'s version
  without running `scripts/version.mjs` (a hand-edit, a different tool, a hotfix branch),
  `suiteVersion.generated.json` silently goes stale and the footer shows a wrong version
  with no error. Mitigation: the umbrella bump is the single write site by convention;
  this ADR documents that convention as load-bearing so it is not "fixed" by reading
  `package.json` directly in a future change.
- **A remote predating this change breaks the precedent, not the shell.** Any remote
  deployed before its `./version` export ships will have the shell's dynamic import
  reject or resolve to `undefined` — expected and handled, but every *future* remote
  addition must be built to this same "the shell may ask for something I don't have yet"
  assumption, or a later shell change could reintroduce a hard failure. Mitigation: this
  ADR names the rule explicitly as reusable for future shell↔remote seams, not scoped
  only to version reporting.

## Compliance notes

Not applicable — this decision concerns build-time version metadata only; no personal or
estimate/refund data is read, transmitted, or logged as part of either mechanism. Data
residency and audit-trail posture are unaffected.

This decision builds directly on ADR-0006 (Module Federation composition — both halves of
this decision extend its `exposes`/`consumes` contract: the shell's read of the umbrella
version stays inside its own build root the same way `shell/session` stays same-origin at
runtime, and the remotes' new `./version` export is one more entry in the same
`exposes` map every remote already has) and ADR-0009 (the shell↔remote seam — this ADR
extends that precedent from "add one new remote" to "add one export across all existing
remotes simultaneously," and introduces the new, reusable "a remote may predate a shell
expectation and must degrade silently" rule that ADR-0009 did not need, since `notify-ui`
and the shell shipped together).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
