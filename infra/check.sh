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
#   AUTH_URL=https://auth.staging... API_URL=... ./infra/check.sh
#   ./infra/check.sh --prereqs           # tooling only (pre-deploy)
#
# Exit code: 0 if every executed check passed, 1 otherwise.

set -uo pipefail

# ─── URLs (override via env) ──────────────────────────────────────────────────
AUTH_URL="${AUTH_URL:-https://auth.operai.welld.io}"
API_URL="${API_URL:-https://estimai-api.operai.welld.io}"
SHELL_URL="${SHELL_URL:-https://operai.welld.io}"
ESTIMAI_URL="${ESTIMAI_URL:-https://estimai.operai.welld.io}"
REFUND_URL="${REFUND_URL:-https://refund.operai.welld.io}"
ADMIN_URL="${ADMIN_URL:-https://admin.operai.welld.io}"
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
have bun     && pass "bun ($(bun -v 2>/dev/null))"   || fail "bun missing (auth/estimai-api runtime)"
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

# JWKS: the resource-server verification key. MUST be /auth/jwks (better-auth's
# rotating DB keypair), NOT /.well-known/jwks.json (orphaned env key).
JWKS="$(body "$AUTH_URL/auth/jwks")"
if echo "$JWKS" | grep -q '"kty"' && echo "$JWKS" | grep -q 'RS256\|"RSA"'; then
  pass "JWKS at /auth/jwks serves an RS256 key set"
else
  fail "JWKS at $AUTH_URL/auth/jwks did not return an RSA key set (estimai-api verifies tokens here)"
fi
# Token endpoint should exist and reject anonymous callers (401), not 404.
tc="$(code "$AUTH_URL/auth/token")"; { [[ "$tc" == 401 || "$tc" == 200 ]] && pass "/auth/token reachable (HTTP $tc)"; } || fail "/auth/token unexpected (HTTP $tc)"
# Sign-in page (hosted, ADR-0002).
[[ "$(code "$AUTH_URL/sign-in")" =~ ^(200|302|307)$ ]] && pass "hosted /sign-in reachable" || warn "/sign-in not obviously reachable (HTTP $(code "$AUTH_URL/sign-in"))"

# ─── 3. Frontends (Vercel) ────────────────────────────────────────────────────
head "Frontends (Vercel)"
[[ "$(code "$SHELL_URL/")" == 200 ]] && pass "shell 200 ($SHELL_URL) — the entry point" || fail "shell not 200 ($SHELL_URL)"
for pair in "estimai-ui:$ESTIMAI_URL" "refund-ui:$REFUND_URL" "admin-ui:$ADMIN_URL"; do
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
  for origin in "$ESTIMAI_URL" "$REFUND_URL" "$ADMIN_URL"; do
    echo "$CSP" | grep -q "$origin" && pass "  CSP allows $origin" || fail "  CSP is MISSING $origin (remote will be blocked)"
  done
  echo "$CSP" | grep -q "$AUTH_URL" && pass "  CSP connect-src allows auth" || warn "  CSP may not list $AUTH_URL in connect-src"
else fail "no Content-Security-Policy header on the shell (shell/vercel.json)"; fi

# EstimAI old-URL → shell redirect (AC-4.3): only for a top-level document nav.
LOC="$(curl -s -I -m 8 -H 'sec-fetch-dest: document' "$ESTIMAI_URL/" 2>/dev/null | grep -i '^location:')"
echo "$LOC" | grep -q "$SHELL_URL/estimai" && pass "estimai origin document-nav redirects to shell/estimai" || warn "estimai→shell redirect not observed (ok if not configured / behind edge cache)"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 ]]; then echo "$(c '0;32' "All checks passed — ${PASS} ok.")"; exit 0
else echo "$(c '0;31' "${FAIL} check(s) FAILED, ${PASS} ok.")  See infra/README.md."; exit 1; fi
