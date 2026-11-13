#!/usr/bin/env bash
# infra/check.sh — verify an Operai installation.
#
# Two groups of checks:
#   1. Local tooling (prerequisites) — always run.
#   2. Deployed health — run when the service URLs are reachable (defaults to the
#      operai.welld.io scheme; override any URL via env var).
#
# USAGE
#   ./infra/check.sh                     # check tooling + the default prod URLs
#   AUTH_URL=https://auth.staging... API_URL=... NOTIFY_API_URL=... ./infra/check.sh
#   ./infra/check.sh --prereqs           # tooling only (pre-deploy)
#
# Covers all FIVE backends (auth, estimai-api, notify-api, refund-api,
# inventory-api) and all five remotes (estimai-ui, refund-ui, admin-ui,
# notify-ui, inventory-ui), plus the shell CSP — including the notify-api origin in connect-src, the classic
# SSE/EventSource miss (specs/20260713-notification-center Risk R6), the
# refund-api origin in connect-src (specs/20260716-refund-service T20), the
# receipt-bucket origin in connect-src (ADR 20260716-eu-object-storage-refund-attachments's direct-to-bucket upload —
# override the default with REFUND_BUCKET_ORIGIN), and the Google Maps/Places
# origins in script-src/connect-src (ADR 20260804-google-places-browser-direct-referrer-restricted-key, specs/20260803-employee-address —
# override the defaults with MAPS_ORIGIN/PLACES_ORIGIN), and (specs/20261006-hardware-inventory) the
# inventory-api origin in connect-src, the inventory-ui origin in script-src +
# connect-src and the invoice-bucket origin (override INVENTORY_BUCKET_ORIGIN).
# specs/20261101-crm + specs/20261103-projects add crm-api / crm-ui and projects-api / projects-ui to the same checks
# (health, an anonymous 401 on a gated route, remoteEntry.js + CORS, the three CSP pins), plus
# crm-api's service-credential route GET /system/companies answering 401 to a call with no
# credential. Override PROJECTS_API_URL / PROJECTS_URL (ASSUMED hostnames) if the domains differ.
# specs/20261110-activities adds activities-api (no UI of its own): healthy, the JWT gate on a user route, the
# service-credential gate on /system/v1/*, and the CSP connect-src pin. Override ACTIVITIES_API_URL.
# specs/20261116-letterhead-service adds letterhead-api (no UI probed here: letterheads-ui is a remote of its own): healthy,
# the service-credential gate on GET /v1/letterheads/status and POST /v1/render/pdf (a call with no credential is the one 401),
# and the connect-src pin. Override LETTERHEAD_API_URL.
# specs/20261119-accounting adds accounting-api (its remote, accounting-ui, is not probed here): healthy, a 401 on the user route GET /v1/me with no
# token, a 401 on the service route GET /system/v1/entities/welld_ch/reference-data with no credential (the one frozen body), and the connect-src
# pin. Override ACCOUNTING_API_URL.
# specs/029 adds hours-api / hours-ui (the Hours screens, open to every signed-in user): healthy, an
# anonymous 401 on a user route (GET /time-entries), remoteEntry.js + CORS, the three CSP pins — and
# meetings-api's service-credential route GET /system/meetings/hosts answering 401 to a call with no
# credential (404 = a build older than specs/029 T9). Override HOURS_API_URL / HOURS_URL (ASSUMED hostnames).
# Also probes
# notify-api's two internal endpoints (specs/20260713-user-invitations, specs/20261013-notify-service-credentials) — see § 2b below:
# neither accepts the retired X-Internal-Token header and neither answers an
# anonymous call. No credential is needed or read for these checks. Two inventory
# negative controls (no credentials needed): auth's POST /system/service-token
# must answer 401 to bad client credentials and inventory-api must answer 401 to
# an anonymous request on a gated route (a 404/500 means the endpoint/gate is not
# deployed).
#
# Read-only: every request here is a GET/HEAD, or a POST carrying bogus
# credentials that is rejected before any state changes.
#
# Exit code: 0 if every executed check passed, 1 otherwise.

set -uo pipefail

# ─── URLs (override via env) ──────────────────────────────────────────────────
AUTH_URL="${AUTH_URL:-https://auth.operai.welld.io}"
API_URL="${API_URL:-https://estimai-api.operai.welld.io}"
NOTIFY_API_URL="${NOTIFY_API_URL:-https://notify-api.operai.welld.io}"
REFUND_API_URL="${REFUND_API_URL:-https://refund-api.operai.welld.io}"
# ASSUMED hostnames (specs/20261006-hardware-inventory): the ones shell/vercel.json's CSP already names.
# They do NOT resolve until the Vercel project / Railway custom domain + DNS
# exist (infra/README.md § Rollout checklist) — until then the inventory checks
# below fail by design. Override both if the real domains differ.
INVENTORY_API_URL="${INVENTORY_API_URL:-https://inventory-api.operai.welld.io}"
SHELL_URL="${SHELL_URL:-https://operai.welld.io}"
ESTIMAI_URL="${ESTIMAI_URL:-https://estimai.operai.welld.io}"
REFUND_URL="${REFUND_URL:-https://refund.operai.welld.io}"
ADMIN_URL="${ADMIN_URL:-https://admin.operai.welld.io}"
NOTIFY_URL="${NOTIFY_URL:-https://notify.operai.welld.io}"
INVENTORY_URL="${INVENTORY_URL:-https://inventory.operai.welld.io}"   # ASSUMED, see above
# specs/20261101-crm: provisioned 2026-11-02 (provision-tool.sh crm --bucket).
CRM_API_URL="${CRM_API_URL:-https://crm-api.operai.welld.io}"
CRM_URL="${CRM_URL:-https://crm.operai.welld.io}"
# specs/20261104-meetings: provisioned 2026-11-07 (provision-tool.sh meetings --bucket).
MEETINGS_API_URL="${MEETINGS_API_URL:-https://meetings-api.operai.welld.io}"
MEETINGS_URL="${MEETINGS_URL:-https://meetings.operai.welld.io}"

# ASSUMED hostnames (specs/20261103-projects): the ones shell/vercel.json's CSP already names. They
# do NOT resolve until the Railway service / Vercel project + custom domains + DNS exist
# (infra/provision-tool.sh) — until then the projects checks below fail by design. Override
# both if the real domains differ.
PROJECTS_API_URL="${PROJECTS_API_URL:-https://projects-api.operai.welld.io}"
PROJECTS_URL="${PROJECTS_URL:-https://projects.operai.welld.io}"

# ASSUMED hostname (specs/20261110-activities): the one shell/vercel.json's CSP already names. It does
# NOT resolve until the Railway service + custom domain + DNS exist (provision-tool skill) — until
# then the activities-api checks below fail by design. Override if the real domain differs.
ACTIVITIES_API_URL="${ACTIVITIES_API_URL:-https://activities-api.operai.welld.io}"

# specs/20261116-letterhead-service: the hostname shell/vercel.json's CSP already names (T13 declares it in .railway/railway.ts). It does
# NOT resolve until the Railway service + custom domain + DNS exist (T40, infra/README.md § letterhead-api service) — until then the
# letterhead-api checks below fail by design. Override if the real domain differs.
LETTERHEAD_API_URL="${LETTERHEAD_API_URL:-https://letterhead-api.operai.welld.io}"

# specs/20261119-accounting: the hostname shell/vercel.json's CSP already names. It does NOT resolve until the Railway service, its custom
# domain and its DNS exist (infra/README.md § Accounting release runbook, step 1) — until then the accounting-api checks below fail by design.
# Override if the real domain differs.
ACCOUNTING_API_URL="${ACCOUNTING_API_URL:-https://accounting-api.operai.welld.io}"

# ASSUMED hostnames (specs/029-time-tracking): the ones shell/vercel.json's CSP names. They do NOT
# resolve until the Railway service / Vercel project + custom domains + DNS exist
# (`infra/provision-tool.sh hours`, infra/README.md § Time tracking) — until then the hours checks
# below fail by design. Override both if the real domains differ.
HOURS_API_URL="${HOURS_API_URL:-https://hours-api.operai.welld.io}"
HOURS_URL="${HOURS_URL:-https://hours.operai.welld.io}"
PREREQS_ONLY=false; [[ "${1:-}" == "--prereqs" ]] && PREREQS_ONLY=true

PASS=0; FAIL=0
c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
pass() { echo "  $(c '0;32' '✓') $*"; PASS=$((PASS+1)); }
fail() { echo "  $(c '0;31' '✗') $*"; FAIL=$((FAIL+1)); }
warn() { echo "  $(c '1;33' '•') $*"; }
head() { echo ""; echo "$(c '1;36' "== $* ==")"; }

# curl helpers
code() { curl -s -o /dev/null -m 8 -w '%{http_code}' "$@" 2>/dev/null; }
hdrs() { curl -s -I -m 8 "$@" 2>/dev/null; }
body() { curl -s -m 8 "$@" 2>/dev/null; }
have() { command -v "$1" >/dev/null 2>&1; }

# ─── 1. Local tooling ─────────────────────────────────────────────────────────
head "Prerequisites (local tooling)"
have railway && pass "railway CLI" || fail "railway CLI missing — https://docs.railway.app/develop/cli"
have vercel  && pass "vercel CLI"  || warn "vercel CLI missing (needed only to automate Vercel) — https://vercel.com/docs/cli"
have direnv  && pass "direnv"       || fail "direnv missing (backend secrets load via .envrc)"
have op      && pass "1Password CLI (op)" || fail "1Password CLI missing (op) — secrets source"
have node    && pass "node ($(node -v 2>/dev/null))" || fail "node missing"
have bun     && pass "bun ($(bun -v 2>/dev/null))"   || fail "bun missing (auth/estimai-api/notify-api/refund-api/inventory-api runtime)"
have pnpm    && pass "pnpm ($(pnpm -v 2>/dev/null))" || fail "pnpm missing (frontends)"
have docker  && pass "docker (local Postgres)" || warn "docker missing (only needed for local dev)"
if have op; then op whoami >/dev/null 2>&1 && pass "1Password unlocked (op signed in)" || warn "1Password locked — run: op signin (needed for deploy/commits)"; fi

if $PREREQS_ONLY; then
  echo ""; echo "$(c '1;36' "Prereqs: ${PASS} ok, ${FAIL} problem(s).")"; [[ $FAIL -eq 0 ]]; exit
fi

# ─── 2. Backends ──────────────────────────────────────────────────────────────
head "Backends (Railway)"
[[ "$(code "$AUTH_URL/health")" == 200 ]] && pass "auth /health 200 ($AUTH_URL)" || fail "auth /health not 200 ($AUTH_URL)"
[[ "$(code "$API_URL/health")"  == 200 ]] && pass "estimai-api /health 200 ($API_URL)" || fail "estimai-api /health not 200 ($API_URL)"

# notify-api (specs/20260713-notification-center): DB connectivity gates the
# 200/503 status code (same contract as estimai-api). jwks/sse are
# informational sub-fields on top (notify-api/src/health/health.routes.ts) —
# they do NOT gate the status code, so treat a "not-ready" jwks as a warning,
# not a failure: JWKS is fetched lazily on the first verification attempt, so
# a cold "not-ready" reading right after deploy is expected, not an outage.
NOTIFY_HEALTH_CODE="$(code "$NOTIFY_API_URL/health")"
if [[ "$NOTIFY_HEALTH_CODE" == 200 ]]; then
  pass "notify-api /health 200 ($NOTIFY_API_URL)"
  NOTIFY_HEALTH_BODY="$(body "$NOTIFY_API_URL/health")"
  if echo "$NOTIFY_HEALTH_BODY" | grep -qE '"jwks"[[:space:]]*:[[:space:]]*\{[[:space:]]*"status"[[:space:]]*:[[:space:]]*"ok"'; then
    pass "  notify-api JWKS verifier ready"
  else
    warn "  notify-api JWKS verifier reports not-ready (cold start is normal right after deploy; re-run check.sh if this persists)"
  fi
else
  fail "notify-api /health not 200 ($NOTIFY_API_URL, got HTTP ${NOTIFY_HEALTH_CODE:-?})"
fi

# refund-api (specs/20260716-refund-service): same DB-connectivity-gates-status
# contract as estimai-api/notify-api above.
[[ "$(code "$REFUND_API_URL/health")" == 200 ]] && pass "refund-api /health 200 ($REFUND_API_URL)" || fail "refund-api /health not 200 ($REFUND_API_URL)"

# inventory-api (specs/20261006-hardware-inventory): same DB-connectivity-gates-status
# contract. ASSUMED hostname until DNS exists — see INVENTORY_API_URL above.
[[ "$(code "$INVENTORY_API_URL/health")" == 200 ]] && pass "inventory-api /health 200 ($INVENTORY_API_URL)" || fail "inventory-api /health not 200 ($INVENTORY_API_URL)"
# Authorization is enforced, not just deployed: an anonymous request on a gated
# route is a 401 (never 200, and never 404/500 which would mean the route or
# the JWT middleware is not live). GET /assets needs a valid Bearer JWT.
IAC="$(code "$INVENTORY_API_URL/assets")"
[[ "$IAC" == 401 ]] && pass "inventory-api rejects an anonymous request on a gated route (401)" || fail "inventory-api GET /assets without a token did not return 401 (got HTTP ${IAC:-?}) — the JWT gate may be missing or the service not deployed"

# crm-api (specs/20261101-crm–020): same contract — healthy, and the JWT gate is live.
[[ "$(code "$CRM_API_URL/health")" == 200 ]] && pass "crm-api /health 200 ($CRM_API_URL)" || fail "crm-api /health not 200 ($CRM_API_URL)"
CAC="$(code "$CRM_API_URL/companies")"
[[ "$CAC" == 401 ]] && pass "crm-api rejects an anonymous request on a gated route (401)" || fail "crm-api GET /companies without a token did not return 401 (got HTTP ${CAC:-?}) — the JWT gate may be missing or the service not deployed"
# specs/20261103-projects (ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential): GET /system/companies is the service-credential route projects-api reads
# company names from. No credential at all is the frozen 401 (also the answer while SERVICE_AUDIENCE
# is unset); a 404 means crm-api predates specs/20261103-projects. No credential is used, read or printed.
CSC="$(code "$CRM_API_URL/system/companies")"
[[ "$CSC" == 401 ]] && pass "crm-api /system/companies rejects a call with no credential (401)" || fail "crm-api GET /system/companies without a credential did not return 401 (got HTTP ${CSC:-?}) — 404 = a crm-api build older than specs/20261103-projects, anything else = the service-credential gate is not live (ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential)"

# projects-api (specs/20261103-projects): same contract — healthy (the DB connection gates the status code),
# and the JWT gate is live. ASSUMED hostname until DNS exists — see PROJECTS_API_URL above.
[[ "$(code "$PROJECTS_API_URL/health")" == 200 ]] && pass "projects-api /health 200 ($PROJECTS_API_URL)" || fail "projects-api /health not 200 ($PROJECTS_API_URL)"
PAC="$(code "$PROJECTS_API_URL/projects")"
[[ "$PAC" == 401 ]] && pass "projects-api rejects an anonymous request on a gated route (401)" || fail "projects-api GET /projects without a token did not return 401 (got HTTP ${PAC:-?}) — the JWT gate may be missing or the service not deployed"

# activities-api (specs/20261110-activities): /health stays 200 even in maintenance (ADR 20261110-activities-migration-write-pause); the JWT gate
# is probed on a user route and the service-credential gate on a system route (ADR 20261110-caller-chosen-ids-replace-cross-service-transactions), with no
# credential at all. In maintenance mode (ACTIVITIES_MAINTENANCE=true, the migration window) every
# route but /health answers 503 `maintenance` BEFORE authentication, so the gates cannot be proven
# then: that is reported as a warning, not a pass, and not a failure either.
[[ "$(code "$ACTIVITIES_API_URL/health")" == 200 ]] && pass "activities-api /health 200 ($ACTIVITIES_API_URL)" || fail "activities-api /health not 200 ($ACTIVITIES_API_URL) — ASSUMED hostname until DNS exists (specs/20261110-activities)"
AAC="$(code "$ACTIVITIES_API_URL/tasks")"
if [[ "$AAC" == 401 ]]; then pass "activities-api rejects an anonymous request on a gated route (401)"
elif [[ "$AAC" == 503 ]]; then warn "activities-api GET /tasks answered 503 — maintenance mode (ACTIVITIES_MAINTENANCE=true)? the JWT gate cannot be proven until it is off"
else fail "activities-api GET /tasks without a token did not return 401 (got HTTP ${AAC:-?}) — the JWT gate may be missing or the service not deployed"; fi
ASC="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X PUT -H 'Content-Type: application/json' -d '{}' \
  "$ACTIVITIES_API_URL/system/v1/activities/00000000-0000-4000-8000-000000000000" 2>/dev/null)"
if [[ "$ASC" == 401 ]]; then pass "activities-api /system/v1/* rejects a call with no credential (401)"
elif [[ "$ASC" == 503 ]]; then warn "activities-api PUT /system/v1/activities/{id} answered 503 — maintenance mode? the service-credential gate cannot be proven until it is off"
else fail "activities-api PUT /system/v1/activities/{id} without a credential did not return 401 (got HTTP ${ASC:-?}) — 404 = a build older than specs/20261110-activities T10, anything else = the service-credential gate is not live (ADR 20261110-caller-chosen-ids-replace-cross-service-transactions)"; fi

# letterhead-api (specs/20261116-letterhead-service, Rust): /health is 200 once its startup checks passed (env, EU bucket, database up to
# date — it exits rather than serve otherwise). Its service routes answer the single frozen 401 to a call with no credential
# (letterhead-api/api/src/auth/service.rs), BEFORE any body is read, so no credential is used, read or printed; a 404 means
# the route is not live, 503 a service that is up but not ready. ASSUMED hostname until DNS exists — see LETTERHEAD_API_URL above.
[[ "$(code "$LETTERHEAD_API_URL/health")" == 200 ]] && pass "letterhead-api /health 200 ($LETTERHEAD_API_URL)" || fail "letterhead-api /health not 200 ($LETTERHEAD_API_URL) — ASSUMED hostname until DNS exists (specs/20261116-letterhead-service); a failed startup check keeps it down: read its deploy log"
LSC="$(code "$LETTERHEAD_API_URL/v1/letterheads/status")"
[[ "$LSC" == 401 ]] && pass "letterhead-api GET /v1/letterheads/status rejects a call with no credential (401)" || fail "letterhead-api GET /v1/letterheads/status without a credential did not return 401 (got HTTP ${LSC:-?}) — the service-credential gate may be missing or the service not deployed"
LRC="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$LETTERHEAD_API_URL/v1/render/pdf" 2>/dev/null)"
[[ "$LRC" == 401 ]] && pass "letterhead-api POST /v1/render/pdf rejects a call with no credential (401)" || fail "letterhead-api POST /v1/render/pdf without a credential did not return 401 (got HTTP ${LRC:-?}) — 404 = the route is not live, anything else = the service-credential gate is not live (specs/20261116-letterhead-service AC-3.1)"

# accounting-api (specs/20261119-accounting): /health is 200 once the service started (its env validated) and Prisma reaches the database
# (503 = up but the database is not). Both routes below are probed with NO credential, so nothing is used, read or printed: the user route
# GET /v1/me answers the JWT gate's 401 and the service route GET /system/v1/entities/{entity}/reference-data answers the one frozen 401 of
# systemAuth, before the entity is looked at. A 404 means the route is not live (an older build), 403 or 200 that a gate is missing.
# ASSUMED hostname until DNS exists — see ACCOUNTING_API_URL above.
[[ "$(code "$ACCOUNTING_API_URL/health")" == 200 ]] && pass "accounting-api /health 200 ($ACCOUNTING_API_URL)" || fail "accounting-api /health not 200 ($ACCOUNTING_API_URL) — ASSUMED hostname until DNS exists (specs/20261119-accounting); a failed start (a missing variable, the database named accounting not created) keeps it down: read its deploy log"
AMC="$(code "$ACCOUNTING_API_URL/v1/me")"
[[ "$AMC" == 401 ]] && pass "accounting-api GET /v1/me rejects an anonymous request (401)" || fail "accounting-api GET /v1/me without a token did not return 401 (got HTTP ${AMC:-?}) — the JWT gate may be missing or the service not deployed"
ASYC="$(code "$ACCOUNTING_API_URL/system/v1/entities/welld_ch/reference-data")"
[[ "$ASYC" == 401 ]] && pass "accounting-api /system/v1/* rejects a call with no credential (401)" || fail "accounting-api GET /system/v1/entities/welld_ch/reference-data without a credential did not return 401 (got HTTP ${ASYC:-?}) — 404 = a build older than specs/20261119-accounting T13, anything else = the service-credential gate is not live"

# meetings-api (specs/20261104-meetings): same contract. A healthy answer also means every startup check passed
# (EU locations, the audio bucket's 29-day rule, the transient Google bucket, Vertex settings) —
# the service exits rather than serve when one fails (ADR 20261104-meetings-ai-providers-eu-zero-retention/0063/0069).
[[ "$(code "$MEETINGS_API_URL/health")" == 200 ]] && pass "meetings-api /health 200 ($MEETINGS_API_URL)" || fail "meetings-api /health not 200 ($MEETINGS_API_URL) — a failed startup check keeps it down: read its deploy log"
MAC="$(code "$MEETINGS_API_URL/meetings")"
[[ "$MAC" == 401 ]] && pass "meetings-api rejects an anonymous request on a gated route (401)" || fail "meetings-api GET /meetings without a token did not return 401 (got HTTP ${MAC:-?}) — the JWT gate may be missing or the service not deployed"
# specs/029 (ADR-0089): GET /system/meetings/hosts is the service-credential route hours-api reads a
# meeting's current deal from (scope meetings.hosts.read, sub system:hours-api). No credential at all is the
# frozen 401 — also the answer while SERVICE_AUDIENCE is unset, so this proves the route and its gate exist,
# not that the variable is set (its absence makes hours-api read every meeting's deal as unavailable). A 404
# means meetings-api predates specs/029 T9. No credential is used, read or printed.
MSH="$(code "$MEETINGS_API_URL/system/meetings/hosts")"
[[ "$MSH" == 401 ]] && pass "meetings-api /system/meetings/hosts rejects a call with no credential (401)" || fail "meetings-api GET /system/meetings/hosts without a credential did not return 401 (got HTTP ${MSH:-?}) — 404 = a meetings-api build older than specs/029 T9, anything else = the service-credential gate is not live (ADR-0089)"

# hours-api (specs/029-time-tracking): same contract — healthy (the DB connection gates the status code), and
# the JWT gate is live on every route but /health, with no credential at all. The Hours screens are open to
# every signed-in user (AC-5.1), so there is no access grant to probe: the JWT gate is the check. ASSUMED
# hostname until DNS exists — see HOURS_API_URL above.
[[ "$(code "$HOURS_API_URL/health")" == 200 ]] && pass "hours-api /health 200 ($HOURS_API_URL)" || fail "hours-api /health not 200 ($HOURS_API_URL) — ASSUMED hostname until DNS exists (specs/029)"
HRC="$(code "$HOURS_API_URL/time-entries")"
[[ "$HRC" == 401 ]] && pass "hours-api rejects an anonymous request on a gated route (401)" || fail "hours-api GET /time-entries without a token did not return 401 (got HTTP ${HRC:-?}) — the JWT gate may be missing or the service not deployed"

# JWKS: the resource-server verification key. MUST be /auth/jwks (better-auth's
# rotating DB keypair), NOT /.well-known/jwks.json (orphaned env key).
# estimai-api, notify-api, and refund-api all verify against this same endpoint.
JWKS="$(body "$AUTH_URL/auth/jwks")"
if echo "$JWKS" | grep -q '"kty"' && echo "$JWKS" | grep -q 'RS256\|"RSA"'; then
  pass "JWKS at /auth/jwks serves an RS256 key set"
else
  fail "JWKS at $AUTH_URL/auth/jwks did not return an RSA key set (estimai-api and notify-api verify tokens here)"
fi
# Token endpoint should exist and reject anonymous callers (401), not 404.
tc="$(code "$AUTH_URL/auth/token")"; { [[ "$tc" == 401 || "$tc" == 200 ]] && pass "/auth/token reachable (HTTP $tc)"; } || fail "/auth/token unexpected (HTTP $tc)"
# Service-token endpoint (specs/20261006-hardware-inventory, ADR 20261006-scoped-service-jwt-fourth-notify-caller): bogus client credentials must be
# the frozen 401 — 404 means the endpoint is not deployed, 500 a broken signer.
# An unknown client and a wrong secret are the same response by design, so this
# needs no real credential. The endpoint is rate limited per address (default
# 20 per 10 min); a single probe per run is far below that, a 429 is a warning.
STC="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"clientId":"check-sh-probe","clientSecret":"not-a-real-secret"}' "$AUTH_URL/system/service-token" 2>/dev/null)"
if [[ "$STC" == 401 ]]; then pass "auth POST /system/service-token rejects bad client credentials (401)"
elif [[ "$STC" == 429 ]]; then warn "auth POST /system/service-token rate-limited this probe (429) — the endpoint is live; re-run later for the 401 assertion"
else fail "auth POST /system/service-token did not return 401 for bad credentials (got HTTP ${STC:-?}) — 404 = endpoint not deployed, 500 = signer/config fault (ADR 20261006-scoped-service-jwt-fourth-notify-caller)"; fi
# Sign-in page (hosted, ADR 20260607-sign-in-page-hosted-by-auth-service).
[[ "$(code "$AUTH_URL/sign-in")" =~ ^(200|302|307)$ ]] && pass "hosted /sign-in reachable" || warn "/sign-in not obviously reachable (HTTP $(code "$AUTH_URL/sign-in"))"

# ─── 2b. notify-api internal endpoints (specs/20260713-user-invitations, specs/20261013-notify-service-credentials, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired) ───────
# POST /system/emails and POST /system/notifications are notify-api's
# service-to-service endpoints. Each caller authenticates with its own scoped
# service JWT (Authorization: Bearer); the old shared X-Internal-Token header is
# retired and must authenticate nothing. A 401 here is the frozen answer for "no
# valid service credential": 404/500 would mean the route or its middleware is not
# live. No real credential is used, read or printed. (A bogus header value cannot
# prove that the retired SECRET is refused — that is proven by the variable being
# absent from every service, infra/README.md § Notify credential rollout, step 6.)
head "notify-api internal endpoints — service-credential gate"
for route in /system/emails /system/notifications; do
  url="$NOTIFY_API_URL$route"
  ANON_CODE="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -d '{}' "$url" 2>/dev/null)"
  [[ "$ANON_CODE" == 401 ]] \
    && pass "$route rejects a call with no credential (401)" \
    || fail "$route did not return 401 for a call with no credential (got HTTP ${ANON_CODE:-?}) — the service-credential gate may be missing or the service not deployed"
  LEGACY_CODE="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -H 'X-Internal-Token: not-a-credential' \
    -d '{}' "$url" 2>/dev/null)"
  [[ "$LEGACY_CODE" == 401 ]] \
    && pass "$route rejects an X-Internal-Token header (401) — the shared-token mechanism is retired" \
    || fail "$route did not return 401 for an X-Internal-Token header (got HTTP ${LEGACY_CODE:-?}) — the retired shared-token path may still be live (specs/20261013-notify-service-credentials AC-5.1)"
done

# ─── 3. Frontends (Vercel) ────────────────────────────────────────────────────
head "Frontends (Vercel)"
[[ "$(code "$SHELL_URL/")" == 200 ]] && pass "shell 200 ($SHELL_URL) — the entry point" || fail "shell not 200 ($SHELL_URL)"
for pair in "estimai-ui:$ESTIMAI_URL" "refund-ui:$REFUND_URL" "admin-ui:$ADMIN_URL" "notify-ui:$NOTIFY_URL" "inventory-ui:$INVENTORY_URL" "crm-ui:$CRM_URL" "meetings-ui:$MEETINGS_URL" "projects-ui:$PROJECTS_URL" "hours-ui:$HOURS_URL"; do
  name="${pair%%:*}"; url="${pair#*:}"
  re="$(hdrs "$url/remoteEntry.js")"
  if echo "$re" | grep -qiE '^HTTP.* 200'; then
    if echo "$re" | grep -qi 'access-control-allow-origin'; then pass "$name remoteEntry.js 200 + CORS header"; else fail "$name remoteEntry.js 200 but NO Access-Control-Allow-Origin (shell can't load it cross-origin)"; fi
  else fail "$name remoteEntry.js not 200 ($url)"; fi
done

# ─── 4. Shell security headers + wiring ───────────────────────────────────────
head "Shell CSP + wiring"
CSP="$(hdrs "$SHELL_URL/" | grep -i '^content-security-policy:')"
if [[ -n "$CSP" ]]; then
  pass "CSP header present"
  for origin in "$ESTIMAI_URL" "$REFUND_URL" "$ADMIN_URL" "$NOTIFY_URL" "$INVENTORY_URL" "$CRM_URL" "$PROJECTS_URL"; do
    echo "$CSP" | grep -q "$origin" && pass "  CSP allows $origin" || fail "  CSP is MISSING $origin (remote will be blocked)"
  done
  echo "$CSP" | grep -q "$AUTH_URL" && pass "  CSP connect-src allows auth" || warn "  CSP may not list $AUTH_URL in connect-src"

  # specs/20260713-notification-center Risk R6 — the classic miss: EventSource (SSE) is governed by
  # connect-src, NOT script-src. notify.operai.welld.io alone (the remote
  # origin, checked in the loop above) is NOT sufficient — the SSE stream's
  # own origin (notify-api) must be enumerated specifically inside the
  # connect-src directive, or the shell's EventSource to
  # GET /notifications/stream is silently blocked by the browser.
  CONNECT_SRC="$(echo "$CSP" | grep -oiE 'connect-src[^;]*')"
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$NOTIFY_API_URL"; then
    pass "  CSP connect-src includes $NOTIFY_API_URL (SSE EventSource origin — R6)"
  else
    fail "  CSP connect-src is MISSING $NOTIFY_API_URL — the notification SSE stream will be blocked (specs/20260713-notification-center Risk R6: connect-src governs EventSource, not script-src)"
  fi

  # specs/20260716-refund-service T20 — the trusted-origin fix: refund-api must be
  # in connect-src too (an ordinary fetch target via refund-ui's apiFetch
  # calls, not SSE, but connect-src governs fetch/XHR origins as well as
  # EventSource). Without this pin the shell's own CSP — independent of the
  # session.ts trusted-origins allowlist check elsewhere — would block every
  # refund-api call from the browser regardless of the Bearer header.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$REFUND_API_URL"; then
    pass "  CSP connect-src includes $REFUND_API_URL (refund-api origin — T20)"
  else
    fail "  CSP connect-src is MISSING $REFUND_API_URL — refund-ui's API calls will be blocked by the browser regardless of the Bearer-token trusted-origins fix (specs/20260716-refund-service T20)"
  fi

  # specs/20261006-hardware-inventory — mirrors the refund T20 check above. inventory-api
  # must be in connect-src (apiFetch from inventory-ui runs in the SHELL's document),
  # and the inventory-ui origin must be in BOTH script-src (the remote's
  # remoteEntry.js is a <script>-style load) and connect-src (its chunk fetches).
  # The all-origins loop above only proves the string appears somewhere in the
  # policy; these pin the directive. Hostnames are ASSUMED until DNS exists.
  SCRIPT_SRC="$(echo "$CSP" | grep -oiE 'script-src[^;]*')"
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$INVENTORY_API_URL"; then
    pass "  CSP connect-src includes $INVENTORY_API_URL (inventory-api origin — specs/20261006-hardware-inventory)"
  else
    fail "  CSP connect-src is MISSING $INVENTORY_API_URL — inventory-ui's API calls will be blocked by the browser regardless of the Bearer-token trusted-origins setup (specs/20261006-hardware-inventory)"
  fi
  if [[ -n "$SCRIPT_SRC" ]] && echo "$SCRIPT_SRC" | grep -q "$INVENTORY_URL"; then
    pass "  CSP script-src includes $INVENTORY_URL (inventory-ui remote — specs/20261006-hardware-inventory)"
  else
    fail "  CSP script-src is MISSING $INVENTORY_URL — the shell cannot load inventory-ui's remoteEntry.js (specs/20261006-hardware-inventory)"
  fi
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$INVENTORY_URL"; then
    pass "  CSP connect-src includes $INVENTORY_URL (inventory-ui remote chunks — specs/20261006-hardware-inventory)"
  else
    fail "  CSP connect-src is MISSING $INVENTORY_URL (specs/20261006-hardware-inventory)"
  fi
  # specs/20261101-crm — the same three pins for crm-api and crm-ui.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$CRM_API_URL"; then
    pass "  CSP connect-src includes $CRM_API_URL (crm-api origin — specs/20261101-crm)"
  else
    fail "  CSP connect-src is MISSING $CRM_API_URL — crm-ui's API calls will be blocked (specs/20261101-crm)"
  fi
  if [[ -n "$SCRIPT_SRC" ]] && echo "$SCRIPT_SRC" | grep -q "$CRM_URL"; then
    pass "  CSP script-src includes $CRM_URL (crm-ui remote — specs/20261101-crm)"
  else
    fail "  CSP script-src is MISSING $CRM_URL — the shell cannot load crm-ui's remoteEntry.js (specs/20261101-crm)"
  fi
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$CRM_URL"; then
    pass "  CSP connect-src includes $CRM_URL (crm-ui remote chunks — specs/20261101-crm)"
  else
    fail "  CSP connect-src is MISSING $CRM_URL (specs/20261101-crm)"
  fi
  # specs/20261104-meetings — the same three pins for meetings-api and meetings-ui.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$MEETINGS_API_URL"; then
    pass "  CSP connect-src includes $MEETINGS_API_URL (meetings-api origin — specs/20261104-meetings)"
  else
    fail "  CSP connect-src is MISSING $MEETINGS_API_URL — meetings-ui's API calls will be blocked (specs/20261104-meetings)"
  fi
  if [[ -n "$SCRIPT_SRC" ]] && echo "$SCRIPT_SRC" | grep -q "$MEETINGS_URL"; then
    pass "  CSP script-src includes $MEETINGS_URL (meetings-ui remote — specs/20261104-meetings)"
  else
    fail "  CSP script-src is MISSING $MEETINGS_URL — the shell cannot load meetings-ui's remoteEntry.js (specs/20261104-meetings)"
  fi
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$MEETINGS_URL"; then
    pass "  CSP connect-src includes $MEETINGS_URL (meetings-ui remote chunks — specs/20261104-meetings)"
  else
    fail "  CSP connect-src is MISSING $MEETINGS_URL (specs/20261104-meetings)"
  fi
  # specs/20261110-activities — activities-api has no remote, so one pin: the CRM and projects remotes call
  # it from the shell's origin and the browser blocks the call without connect-src.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$ACTIVITIES_API_URL"; then
    pass "  CSP connect-src includes $ACTIVITIES_API_URL (activities-api origin — specs/20261110-activities)"
  else
    fail "  CSP connect-src is MISSING $ACTIVITIES_API_URL — the CRM and projects activity/task calls will be blocked (specs/20261110-activities)"
  fi
  # specs/20261116-letterhead-service — letterhead-api: the shell's apiFetch calls it from the shell's document (letterheads-ui,
  # its remote, is not probed here), so its origin needs its connect-src pin.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$LETTERHEAD_API_URL"; then
    pass "  CSP connect-src includes $LETTERHEAD_API_URL (letterhead-api origin — specs/20261116-letterhead-service)"
  else
    fail "  CSP connect-src is MISSING $LETTERHEAD_API_URL — the letterheads configurator's API calls will be blocked (specs/20261116-letterhead-service)"
  fi
  # specs/20261119-accounting — accounting-api: the shell's apiFetch calls it from the shell's document (accounting-ui, its remote, is not
  # probed here), so its origin needs its connect-src pin.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$ACCOUNTING_API_URL"; then
    pass "  CSP connect-src includes $ACCOUNTING_API_URL (accounting-api origin — specs/20261119-accounting)"
  else
    fail "  CSP connect-src is MISSING $ACCOUNTING_API_URL — the Accounting screens' API calls will be blocked (specs/20261119-accounting)"
  fi
  # specs/20261103-projects — the same three pins for projects-api and projects-ui.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$PROJECTS_API_URL"; then
    pass "  CSP connect-src includes $PROJECTS_API_URL (projects-api origin — specs/20261103-projects)"
  else
    fail "  CSP connect-src is MISSING $PROJECTS_API_URL — projects-ui's API calls will be blocked (specs/20261103-projects)"
  fi
  if [[ -n "$SCRIPT_SRC" ]] && echo "$SCRIPT_SRC" | grep -q "$PROJECTS_URL"; then
    pass "  CSP script-src includes $PROJECTS_URL (projects-ui remote — specs/20261103-projects)"
  else
    fail "  CSP script-src is MISSING $PROJECTS_URL — the shell cannot load projects-ui's remoteEntry.js (specs/20261103-projects)"
  fi
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$PROJECTS_URL"; then
    pass "  CSP connect-src includes $PROJECTS_URL (projects-ui remote chunks — specs/20261103-projects)"
  else
    fail "  CSP connect-src is MISSING $PROJECTS_URL (specs/20261103-projects)"
  fi
  # specs/029-time-tracking — the same three pins for hours-api and hours-ui. The remote is ungated, but
  # the browser still blocks a script or a fetch whose origin the CSP does not list.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$HOURS_API_URL"; then
    pass "  CSP connect-src includes $HOURS_API_URL (hours-api origin — specs/029)"
  else
    fail "  CSP connect-src is MISSING $HOURS_API_URL — hours-ui's and admin-ui's Time lists API calls will be blocked (specs/029)"
  fi
  if [[ -n "$SCRIPT_SRC" ]] && echo "$SCRIPT_SRC" | grep -q "$HOURS_URL"; then
    pass "  CSP script-src includes $HOURS_URL (hours-ui remote — specs/029)"
  else
    fail "  CSP script-src is MISSING $HOURS_URL — the shell cannot load hours-ui's remoteEntry.js (specs/029)"
  fi
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$HOURS_URL"; then
    pass "  CSP connect-src includes $HOURS_URL (hours-ui remote chunks — specs/029)"
  else
    fail "  CSP connect-src is MISSING $HOURS_URL (specs/029)"
  fi

  # ADR 20260716-eu-object-storage-refund-attachments — receipt uploads POST DIRECTLY to the object-storage bucket, not
  # through refund-api, so the bucket's own origin needs its own connect-src
  # pin. This is the THIRD independent gate on that one request: the bucket's
  # CORS rule, refund-api's presigned policy, and this CSP entry. All three
  # must be right; each fails identically from the user's side ("Upload
  # failed"). Missing here on 2026-07-31, after the bucket CORS was fixed.
  REFUND_BUCKET_ORIGIN="${REFUND_BUCKET_ORIGIN:-https://t3.storageapi.dev}"
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$REFUND_BUCKET_ORIGIN"; then
    pass "  CSP connect-src includes $REFUND_BUCKET_ORIGIN (receipt-bucket upload origin — ADR 20260716-eu-object-storage-refund-attachments)"
  else
    fail "  CSP connect-src is MISSING $REFUND_BUCKET_ORIGIN — every receipt upload will be blocked by the browser before it leaves the page, even with the bucket's CORS rule correct (ADR 20260716-eu-object-storage-refund-attachments direct-to-bucket POST)"
  fi

  # specs/20261006-hardware-inventory — the invoice bucket is its OWN bucket (never refund's) and invoice
  # uploads POST DIRECTLY to it, so its origin needs its own connect-src pin — the
  # same three-gate failure mode as the receipt bucket above (CSP, bucket CORS,
  # presigned-POST policy all fail identically as "upload failed"). ASSUMED to share
  # the refund bucket's host (see infra/README.md § Invoice bucket CORS and CSP):
  # override INVENTORY_BUCKET_ORIGIN once the real bucket exists, and add the origin
  # to shell/vercel.json if it differs. Passing here with the default only proves
  # the refund host is allowed, which is exactly what an inventory bucket on the
  # same host needs.
  INVENTORY_BUCKET_ORIGIN="${INVENTORY_BUCKET_ORIGIN:-$REFUND_BUCKET_ORIGIN}"
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$INVENTORY_BUCKET_ORIGIN"; then
    pass "  CSP connect-src includes $INVENTORY_BUCKET_ORIGIN (invoice-bucket upload origin — specs/20261006-hardware-inventory)"
  else
    fail "  CSP connect-src is MISSING $INVENTORY_BUCKET_ORIGIN — every invoice upload will be blocked by the browser before it leaves the page, even with the bucket's CORS rule correct (specs/20261006-hardware-inventory; infra/README.md § Invoice bucket CORS and CSP)"
  fi

  # specs/20260803-employee-address (ADR 20260804-google-places-browser-direct-referrer-restricted-key) — admin-ui's Google Places (New)
  # address autocomplete runs Module-Federated inside the SHELL's document, so
  # the shell's CSP (not admin-ui's own vercel.json) governs both the bootstrap
  # <script> (script-src) and the SDK's own fetch/XHR calls (connect-src). A
  # missing pin here degrades SILENTLY (AC-3.2 — console.warn only, no error
  # banner), so this check is the only thing that fails loudly on a drift.
  MAPS_ORIGIN="${MAPS_ORIGIN:-https://maps.googleapis.com}"
  PLACES_ORIGIN="${PLACES_ORIGIN:-https://places.googleapis.com}"
  SCRIPT_SRC="$(echo "$CSP" | grep -oiE 'script-src[^;]*')"
  if [[ -n "$SCRIPT_SRC" ]] && echo "$SCRIPT_SRC" | grep -q "$MAPS_ORIGIN"; then
    pass "  CSP script-src includes $MAPS_ORIGIN (Google Maps bootstrap script — ADR 20260804-google-places-browser-direct-referrer-restricted-key)"
  else
    fail "  CSP script-src is MISSING $MAPS_ORIGIN — the Google Maps bootstrap <script> will be blocked outright, so google.maps.importLibrary never materializes (ADR 20260804-google-places-browser-direct-referrer-restricted-key, specs/20260803-employee-address)"
  fi
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$MAPS_ORIGIN"; then
    pass "  CSP connect-src includes $MAPS_ORIGIN (Maps SDK internal calls — ADR 20260804-google-places-browser-direct-referrer-restricted-key)"
  else
    fail "  CSP connect-src is MISSING $MAPS_ORIGIN (ADR 20260804-google-places-browser-direct-referrer-restricted-key, specs/20260803-employee-address)"
  fi
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$PLACES_ORIGIN"; then
    pass "  CSP connect-src includes $PLACES_ORIGIN (Places API (New) autocomplete calls — ADR 20260804-google-places-browser-direct-referrer-restricted-key)"
  else
    fail "  CSP connect-src is MISSING $PLACES_ORIGIN — address autocomplete will silently fall back to manual entry with no visible error (AC-3.2), and the T16 runbook's own 'confirm a 200' verification step can never pass (ADR 20260804-google-places-browser-direct-referrer-restricted-key, specs/20260803-employee-address)"
  fi

  # The CSP above is only worth checking if browsers actually RE-READ it. CSP
  # rides on the response header, and a 304 does not carry it — RFC 9111 keeps
  # headers absent from a 304, so a cached document keeps enforcing the OLD
  # policy. Editing only shell/vercel.json leaves index.html's ETag unchanged,
  # so that 304 path never breaks on its own (2026-08-03: uploads still blocked
  # by a CSP fixed and deployed two days earlier). `max-age=0, must-revalidate`
  # is NOT sufficient — it still permits the 304.
  SHELL_CC="$(hdrs "$SHELL_URL/" | grep -i '^cache-control:' | tr -d '\r')"
  if echo "$SHELL_CC" | grep -qi 'no-store'; then
    pass "  shell document is no-store (a CSP change actually reaches returning browsers)"
  else
    fail "  shell document is NOT no-store ($SHELL_CC) — a cached copy will keep enforcing a STALE CSP, because a 304 revalidation does not carry the header"
  fi
else fail "no Content-Security-Policy header on the shell (shell/vercel.json)"; fi

# EstimAI old-URL → shell redirect (AC-4.3): only for a top-level document nav.
LOC="$(curl -s -I -m 8 -H 'sec-fetch-dest: document' "$ESTIMAI_URL/" 2>/dev/null | grep -i '^location:')"
echo "$LOC" | grep -q "$SHELL_URL/estimai" && pass "estimai origin document-nav redirects to shell/estimai" || warn "estimai→shell redirect not observed (ok if not configured / behind edge cache)"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 ]]; then echo "$(c '0;32' "All checks passed — ${PASS} ok.")"; exit 0
else echo "$(c '0;31' "${FAIL} check(s) FAILED, ${PASS} ok.")  See infra/README.md."; exit 1; fi
