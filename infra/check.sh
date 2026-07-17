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
# Covers all FOUR backends (auth, estimai-api, notify-api, refund-api) and all
# four remotes (estimai-ui, refund-ui, admin-ui, notify-ui), plus the shell
# CSP — including the notify-api origin in connect-src, the classic
# SSE/EventSource miss (specs/005-notification-center Risk R6), and the
# refund-api origin in connect-src (specs/007-refund-service T20). Also probes
# notify-api's internal email-send gate (specs/006-user-invitations,
# ADR-0011) — see § 2b below; export NOTIFY_INTERNAL_TOKEN locally (same
# value configured on auth, notify-api, AND refund-api as of ADR-0017) to get
# the strongest form of that check.
#
# Exit code: 0 if every executed check passed, 1 otherwise.

set -uo pipefail

# ─── URLs (override via env) ──────────────────────────────────────────────────
AUTH_URL="${AUTH_URL:-https://auth.operai.welld.io}"
API_URL="${API_URL:-https://estimai-api.operai.welld.io}"
NOTIFY_API_URL="${NOTIFY_API_URL:-https://notify-api.operai.welld.io}"
REFUND_API_URL="${REFUND_API_URL:-https://refund-api.operai.welld.io}"
SHELL_URL="${SHELL_URL:-https://operai.welld.io}"
ESTIMAI_URL="${ESTIMAI_URL:-https://estimai.operai.welld.io}"
REFUND_URL="${REFUND_URL:-https://refund.operai.welld.io}"
ADMIN_URL="${ADMIN_URL:-https://admin.operai.welld.io}"
NOTIFY_URL="${NOTIFY_URL:-https://notify.operai.welld.io}"
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
have bun     && pass "bun ($(bun -v 2>/dev/null))"   || fail "bun missing (auth/estimai-api/notify-api runtime)"
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

# notify-api (specs/005-notification-center): DB connectivity gates the
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

# refund-api (specs/007-refund-service): same DB-connectivity-gates-status
# contract as estimai-api/notify-api above.
[[ "$(code "$REFUND_API_URL/health")" == 200 ]] && pass "refund-api /health 200 ($REFUND_API_URL)" || fail "refund-api /health not 200 ($REFUND_API_URL)"

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
# Sign-in page (hosted, ADR-0002).
[[ "$(code "$AUTH_URL/sign-in")" =~ ^(200|302|307)$ ]] && pass "hosted /sign-in reachable" || warn "/sign-in not obviously reachable (HTTP $(code "$AUTH_URL/sign-in"))"

# ─── 2b. Invitation email internal endpoint (specs/006, ADR-0011) ────────────
# POST /system/emails is notify-api's service-to-service endpoint (auth calls
# it to send invite/resend emails) — authenticated by a shared secret
# (NOTIFY_INTERNAL_TOKEN), NOT a user JWT. Never print the token value.
head "Invitation email channel — /system/emails gate"
SYSTEM_EMAILS_URL="$NOTIFY_API_URL/system/emails"

# Negative control (always runs): a garbage token must be rejected with 401 —
# proves the internal-token middleware is deployed and live without needing
# to know the real secret.
BOGUS_CODE="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'X-Internal-Token: not-the-real-token' \
  -d '{}' "$SYSTEM_EMAILS_URL" 2>/dev/null)"
[[ "$BOGUS_CODE" == 401 ]] \
  && pass "/system/emails rejects a bad X-Internal-Token (401)" \
  || fail "/system/emails did not return 401 for a bad token (got HTTP ${BOGUS_CODE:-?}) — the internal-token gate may be missing or misconfigured"

# Positive control (opt-in): only runs if NOTIFY_INTERNAL_TOKEN is exported
# locally (same value configured on both auth and notify-api — never printed
# here). Sends a deliberately INVALID body (bad `to`/`template`); the real
# token should get the request PAST the auth gate to schema validation, i.e.
# 400, not 401. A 400 proves your local value matches what's deployed on
# notify-api — the "matching NOTIFY_INTERNAL_TOKEN posture" check — without
# ever risking a real Resend send (an invalid payload never reaches the email
# channel).
if [[ -n "${NOTIFY_INTERNAL_TOKEN:-}" ]]; then
  REAL_CODE="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -H "X-Internal-Token: ${NOTIFY_INTERNAL_TOKEN}" \
    -d '{"to":"not-an-email","template":"bogus-template"}' "$SYSTEM_EMAILS_URL" 2>/dev/null)"
  if [[ "$REAL_CODE" == 400 ]]; then
    pass "/system/emails accepts your NOTIFY_INTERNAL_TOKEN (matches the deployed value — got the expected 400 for a deliberately invalid payload)"
  elif [[ "$REAL_CODE" == 401 ]]; then
    fail "/system/emails rejected your NOTIFY_INTERNAL_TOKEN (401) — your local value does NOT match what notify-api has deployed (check the shared 1Password item / redeploy both services)"
  else
    warn "/system/emails returned HTTP ${REAL_CODE:-?} for the positive-control probe (expected 400) — inspect manually"
  fi
else
  warn "NOTIFY_INTERNAL_TOKEN not set locally — skipping the positive-auth check (the negative 401 check above still confirms the gate is live). Export it (same value as both services' 1Password item) to also confirm the deployed value matches."
fi

# ─── 3. Frontends (Vercel) ────────────────────────────────────────────────────
head "Frontends (Vercel)"
[[ "$(code "$SHELL_URL/")" == 200 ]] && pass "shell 200 ($SHELL_URL) — the entry point" || fail "shell not 200 ($SHELL_URL)"
for pair in "estimai-ui:$ESTIMAI_URL" "refund-ui:$REFUND_URL" "admin-ui:$ADMIN_URL" "notify-ui:$NOTIFY_URL"; do
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
  for origin in "$ESTIMAI_URL" "$REFUND_URL" "$ADMIN_URL" "$NOTIFY_URL"; do
    echo "$CSP" | grep -q "$origin" && pass "  CSP allows $origin" || fail "  CSP is MISSING $origin (remote will be blocked)"
  done
  echo "$CSP" | grep -q "$AUTH_URL" && pass "  CSP connect-src allows auth" || warn "  CSP may not list $AUTH_URL in connect-src"

  # specs/005 Risk R6 — the classic miss: EventSource (SSE) is governed by
  # connect-src, NOT script-src. notify.operai.welld.io alone (the remote
  # origin, checked in the loop above) is NOT sufficient — the SSE stream's
  # own origin (notify-api) must be enumerated specifically inside the
  # connect-src directive, or the shell's EventSource to
  # GET /notifications/stream is silently blocked by the browser.
  CONNECT_SRC="$(echo "$CSP" | grep -oiE 'connect-src[^;]*')"
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$NOTIFY_API_URL"; then
    pass "  CSP connect-src includes $NOTIFY_API_URL (SSE EventSource origin — R6)"
  else
    fail "  CSP connect-src is MISSING $NOTIFY_API_URL — the notification SSE stream will be blocked (specs/005 Risk R6: connect-src governs EventSource, not script-src)"
  fi

  # specs/007-refund-service T20 — the trusted-origin fix: refund-api must be
  # in connect-src too (an ordinary fetch target via refund-ui's apiFetch
  # calls, not SSE, but connect-src governs fetch/XHR origins as well as
  # EventSource). Without this pin the shell's own CSP — independent of the
  # session.ts trusted-origins allowlist check elsewhere — would block every
  # refund-api call from the browser regardless of the Bearer header.
  if [[ -n "$CONNECT_SRC" ]] && echo "$CONNECT_SRC" | grep -q "$REFUND_API_URL"; then
    pass "  CSP connect-src includes $REFUND_API_URL (refund-api origin — T20)"
  else
    fail "  CSP connect-src is MISSING $REFUND_API_URL — refund-ui's API calls will be blocked by the browser regardless of the Bearer-token trusted-origins fix (specs/007-refund-service T20)"
  fi
else fail "no Content-Security-Policy header on the shell (shell/vercel.json)"; fi

# EstimAI old-URL → shell redirect (AC-4.3): only for a top-level document nav.
LOC="$(curl -s -I -m 8 -H 'sec-fetch-dest: document' "$ESTIMAI_URL/" 2>/dev/null | grep -i '^location:')"
echo "$LOC" | grep -q "$SHELL_URL/estimai" && pass "estimai origin document-nav redirects to shell/estimai" || warn "estimai→shell redirect not observed (ok if not configured / behind edge cache)"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 ]]; then echo "$(c '0;32' "All checks passed — ${PASS} ok.")"; exit 0
else echo "$(c '0;31' "${FAIL} check(s) FAILED, ${PASS} ok.")  See infra/README.md."; exit 1; fi
