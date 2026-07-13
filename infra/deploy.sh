#!/usr/bin/env bash
# infra/deploy.sh — automate what can be automated in an Operai deploy.
#
# WHAT THIS AUTOMATES
#   Railway (backends): link the project, ensure the shared Postgres + the
#   three logical databases (auth, estimai, notify), set every env var for the
#   `auth`, `estimai-api`, and `notify-api` services from your
#   direnv/1Password-exported secrets, and trigger their deploys. This
#   includes AUTH_AUDIENCE (ADR-0010, specs/005-notification-center) — the
#   SAME value is set on all three services, closing the cross-service JWT
#   replay gap now that notify-api is a second JWKS resource server. It also
#   sets NOTIFY_INTERNAL_TOKEN (ADR-0011, specs/006-user-invitations) — the
#   SAME value on auth + notify-api only (not estimai-api) — plus auth's
#   NOTIFY_INTERNAL_URL (notify-api's Railway PRIVATE-networking address, not
#   its public domain — plan.md Risk R2) and notify-api's optional
#   EMAIL_ENABLED/RESEND_API_KEY/RESEND_FROM.
#   Migrations + the authz seed run automatically via each service's
#   railway.json preDeployCommand (`bun run db:deploy && …`).
#
#   Vercel (frontends, optional --vercel): push the build-time env vars to the
#   five existing projects (shell, estimai-ui, refund-ui, admin-ui, notify-ui)
#   and trigger a redeploy. Project + custom-domain creation is NOT
#   automatable via CLI here — do it once in the dashboard (see
#   infra/README.md § Vercel), then this keeps env vars in sync.
#
# WHAT STAYS MANUAL (see infra/README.md): creating the Railway project +
#   attaching custom domains; creating the 5 Vercel projects + assigning the 5
#   domains; registering the Google/GitHub OAuth redirect URIs.
#
# USAGE
#   direnv exec auth ./infra/deploy.sh            # backends only (recommended)
#   direnv exec auth ./infra/deploy.sh --vercel   # + sync Vercel env + redeploy
#   AUTH_PUBLIC_URL=https://auth.operai.welld.io ./infra/deploy.sh   # set the JWT issuer
#
# PREREQS: railway CLI (logged in), 1Password-unlocked direnv shell (so the
#   secrets below are exported). For --vercel: vercel CLI (logged in, linked).
#   NEVER put real secret values in this file — it is committed.
#
# DATA RESIDENCY: all backend services + Postgres are pinned to europe-west4.
#   notify-api additionally never logs request/response bodies (notification
#   title/body may name clients/estimates) and is pinned to numReplicas: 1 in
#   notify-api/railway.json — do not scale it without reading plan.md Risk R2.

set -euo pipefail

# ─── Config (override via env) ────────────────────────────────────────────────
RAILWAY_ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
RAILWAY_REGION="europe-west4"
UI_ORIGIN="${UI_ORIGIN:-https://operai.welld.io}"              # the shell's origin (no trailing slash)
DO_VERCEL=false; [[ "${1:-}" == "--vercel" ]] && DO_VERCEL=true

# Frontend build-time URLs (used by --vercel). Override to match real domains.
AUTH_URL="${AUTH_URL:-https://auth.operai.welld.io}"
API_URL="${API_URL:-https://estimai-api.operai.welld.io}"
NOTIFY_API_URL="${NOTIFY_API_URL:-https://notify-api.operai.welld.io}"
ESTIMAI_REMOTE_URL="${ESTIMAI_REMOTE_URL:-https://estimai.operai.welld.io/remoteEntry.js}"
REFUND_REMOTE_URL="${REFUND_REMOTE_URL:-https://refund.operai.welld.io/remoteEntry.js}"
ADMIN_REMOTE_URL="${ADMIN_REMOTE_URL:-https://admin.operai.welld.io/remoteEntry.js}"
SHELL_REMOTE_URL="${SHELL_REMOTE_URL:-https://operai.welld.io/remoteEntry.js}"

# ADR-0010 (specs/005-notification-center): ONE audience value, verified by
# auth (stamps it) and BOTH resource servers (estimai-api, notify-api). Not a
# secret, but must be byte-for-byte identical across all three services — a
# drift fails every request closed (401), not open. Defaults to the same
# local-dev value baked into each service's .env.example; override for a real
# deploy if you want a non-default suite-wide audience string.
AUTH_AUDIENCE="${AUTH_AUDIENCE:-operai-suite}"

# ADR-0011 (specs/006-user-invitations): notify-api's Railway PRIVATE-networking
# address — auth's server-to-server POST /system/emails call must stay off the
# public internet (plan.md Risk R2). This is DIFFERENT from $NOTIFY_API_URL
# above (that one is public, for the browser/SSE only). The exact private
# hostname is visible in the Railway dashboard (notify-api service → Settings
# → Networking → Private Networking) after notify-api's first deploy — override
# this default if yours differs.
NOTIFY_INTERNAL_URL="${NOTIFY_INTERNAL_URL:-http://notify-api.railway.internal:8081}"

# notify-api email channel (specs/006-user-invitations, ADR-0011). EMAIL_ENABLED
# defaults false (invite emails are stubbed — recorded, not actually sent via
# Resend) so a first deploy doesn't require a verified Resend domain up front.
# Flip to true (and provide RESEND_API_KEY/RESEND_FROM) once the domain is
# verified — see infra/README.md § Resend domain setup.
EMAIL_ENABLED="${EMAIL_ENABLED:-false}"
RESEND_FROM="${RESEND_FROM:-no-reply@operai.welld.io}"

# ─── Output helpers ───────────────────────────────────────────────────────────
c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info() { echo "$(c '0;34' '[deploy]') $*"; }
ok()   { echo "$(c '0;32' '[deploy]') $*"; }
warn() { echo "$(c '1;33' '[deploy]') $*"; }
die()  { echo "$(c '0;31' '[deploy] ERROR:') $*" >&2; exit 1; }

# ─── Preconditions ────────────────────────────────────────────────────────────
command -v railway >/dev/null 2>&1 || die "railway CLI not found — https://docs.railway.app/develop/cli"
railway whoami >/dev/null 2>&1    || die "not logged in to Railway — run: railway login"

REQUIRED_SECRETS=(BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
                  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET JWT_PRIVATE_KEY JWT_PUBLIC_KEY
                  NOTIFY_INTERNAL_TOKEN)
info "Checking direnv/1Password-exported secrets…"
for v in "${REQUIRED_SECRETS[@]}"; do
  [[ -n "${!v:-}" ]] || die "\$$v is not set. Run inside the direnv/1Password shell (e.g. \`direnv exec auth ./infra/deploy.sh\`); see infra/README.md."
done
# NOTIFY_INTERNAL_TOKEN (ADR-0011, specs/006) is shared verbatim between auth
# and notify-api — a short value materially weakens the whole trust boundary
# (plan.md Risk R2), so fail fast rather than silently deploying a weak secret.
[[ "${#NOTIFY_INTERNAL_TOKEN}" -ge 32 ]] || die "\$NOTIFY_INTERNAL_TOKEN is only ${#NOTIFY_INTERNAL_TOKEN} chars — notify-api requires >=32 (generate with: openssl rand -hex 32)."
[[ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ]] || warn "BOOTSTRAP_ADMIN_EMAIL not set — the seed will create no bootstrap admin (set it on the auth service to grant the first admin; specs/004 AC-6.1)."
# Case-insensitive match on the literal "true" (mirrors notify-api's own
# EMAIL_ENABLED parsing, src/lib/env.ts). Avoids bash 4+ `${VAR,,}` — macOS
# ships bash 3.2 by default, which doesn't support it.
case "${EMAIL_ENABLED}" in
  [Tt][Rr][Uu][Ee])
    [[ -n "${RESEND_API_KEY:-}" ]] || die "EMAIL_ENABLED=true but \$RESEND_API_KEY is not set — notify-api will refuse to start. Export it, or leave EMAIL_ENABLED unset/false until the Resend domain is verified (infra/README.md § Resend domain setup)."
    ;;
  *)
    warn "EMAIL_ENABLED is not 'true' — invitation emails will be stubbed (recorded, not actually sent via Resend). Fine for a first deploy; see infra/README.md § Resend domain setup before enabling in production."
    ;;
esac
ok "All required secrets present."

# ─── Link the Railway project ─────────────────────────────────────────────────
if [[ -n "${RAILWAY_PROJECT_ID:-}" ]]; then
  info "Linking Railway project ${RAILWAY_PROJECT_ID} (env ${RAILWAY_ENVIRONMENT})…"
  railway link "${RAILWAY_PROJECT_ID}" >/dev/null 2>&1 || true
  railway environment "${RAILWAY_ENVIRONMENT}" >/dev/null 2>&1 || true
else
  die "RAILWAY_PROJECT_ID is not set. Create the project in the Railway dashboard (region ${RAILWAY_REGION}), then export RAILWAY_PROJECT_ID and re-run."
fi

# ─── Ensure shared Postgres + logical databases ───────────────────────────────
if ! railway service list 2>/dev/null | grep -qi postgres; then
  info "Provisioning Postgres (${RAILWAY_REGION})…"; railway add --database postgres || railway add --plugin postgresql
  ok "Postgres provisioned — confirm its region is ${RAILWAY_REGION} in the dashboard before adding data."
else
  ok "Postgres already present."
fi
info "Ensuring logical databases 'auth', 'estimai', and 'notify' exist…"
for DB in auth estimai notify; do
  railway run --service Postgres -- psql "\$DATABASE_URL" -v ON_ERROR_STOP=0 -tc \
    "SELECT 'CREATE DATABASE ${DB}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${DB}')\gexec" \
    >/dev/null 2>&1 || warn "Could not auto-create '${DB}' — create it manually: railway connect Postgres → CREATE DATABASE ${DB};"
done
ok "Logical databases ready."

# ─── auth service vars + deploy ───────────────────────────────────────────────
# ${{Postgres.*}} is Railway reference syntax — single-quote so the shell keeps it literal.
info "Setting auth service variables…"
railway variables --service auth \
  --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/auth' \
  --set "BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}" \
  --set "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}" --set "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}" \
  --set "GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}" --set "GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}" \
  --set "JWT_PRIVATE_KEY=${JWT_PRIVATE_KEY}" --set "JWT_PUBLIC_KEY=${JWT_PUBLIC_KEY}" \
  --set "ALLOWED_ORIGINS=${UI_ORIGIN}" --set "UI_HOME_URL=${UI_ORIGIN}/" \
  --set "AUTH_AUDIENCE=${AUTH_AUDIENCE}" \
  --set "NOTIFY_INTERNAL_URL=${NOTIFY_INTERNAL_URL}" \
  --set "NOTIFY_INTERNAL_TOKEN=${NOTIFY_INTERNAL_TOKEN}" \
  ${BOOTSTRAP_ADMIN_EMAIL:+--set "BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_ADMIN_EMAIL}"} \
  --set "NODE_ENV=production" >/dev/null
# BETTER_AUTH_URL is set after the domain exists (below). PORT / ENABLE_TEST_AUTH /
# BETTER_AUTH_TRUSTED_ORIGINS are intentionally NOT set (see infra/README.md).
railway up --service auth --detach && ok "auth deploy triggered."

# ─── estimai-api service vars + deploy ────────────────────────────────────────
info "Setting estimai-api service variables…"
railway variables --service estimai-api \
  --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/estimai' \
  --set "ALLOWED_ORIGINS=${UI_ORIGIN}" \
  --set "AUTH_ISSUER=${AUTH_PUBLIC_URL:-$AUTH_URL}" \
  --set "AUTH_JWKS_URL=${AUTH_PUBLIC_URL:-$AUTH_URL}/auth/jwks" \
  --set "AUTH_AUDIENCE=${AUTH_AUDIENCE}" \
  --set "NODE_ENV=production" >/dev/null
railway up --service estimai-api --detach && ok "estimai-api deploy triggered."

# ─── notify-api service vars + deploy (specs/005-notification-center) ─────────
# Own logical DB ('notify', NOT 'estimai'); same AUTH_ISSUER/AUTH_JWKS_URL as
# estimai-api (same issuer, same JWKS endpoint) but its OWN AUTH_AUDIENCE value
# (must match auth's and estimai-api's — ADR-0010). railway.json (committed)
# pins numReplicas: 1 — this script does not and must not override that.
# NOTIFY_INTERNAL_TOKEN (ADR-0011, specs/006) must be byte-for-byte identical
# to the value just set on auth above — same $NOTIFY_INTERNAL_TOKEN var, so
# they can't drift within one run of this script. RESEND_API_KEY is only set
# when provided (leaving it unset keeps EMAIL_ENABLED=false safe — notify-api's
# env schema only requires it when EMAIL_ENABLED=true).
info "Setting notify-api service variables…"
railway variables --service notify-api \
  --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/notify' \
  --set "ALLOWED_ORIGINS=${UI_ORIGIN}" \
  --set "AUTH_ISSUER=${AUTH_PUBLIC_URL:-$AUTH_URL}" \
  --set "AUTH_JWKS_URL=${AUTH_PUBLIC_URL:-$AUTH_URL}/auth/jwks" \
  --set "AUTH_AUDIENCE=${AUTH_AUDIENCE}" \
  --set "MAX_STREAM_DURATION=${MAX_STREAM_DURATION:-1800}" \
  --set "NOTIFY_INTERNAL_TOKEN=${NOTIFY_INTERNAL_TOKEN}" \
  --set "EMAIL_ENABLED=${EMAIL_ENABLED}" \
  --set "RESEND_FROM=${RESEND_FROM}" \
  ${RESEND_API_KEY:+--set "RESEND_API_KEY=${RESEND_API_KEY}"} \
  --set "NODE_ENV=production" >/dev/null
railway up --service notify-api --detach && ok "notify-api deploy triggered."

# ─── Cross-wire: auth must know its own public URL (JWT issuer) ────────────────
if [[ -n "${AUTH_PUBLIC_URL:-}" ]]; then
  info "Setting auth BETTER_AUTH_URL=${AUTH_PUBLIC_URL} (JWT issuer)…"
  railway variables --service auth --set "BETTER_AUTH_URL=${AUTH_PUBLIC_URL}" >/dev/null
  railway redeploy --service auth --yes >/dev/null 2>&1 || railway up --service auth --detach
  ok "auth redeployed with issuer."
else
  warn "AUTH_PUBLIC_URL not set → BETTER_AUTH_URL not applied. Generate the auth domain, then re-run with AUTH_PUBLIC_URL=https://<auth-domain> (must equal estimai-api's and notify-api's AUTH_ISSUER)."
fi

# ─── Optional: sync Vercel env + redeploy (projects must already exist) ────────
if $DO_VERCEL; then
  command -v vercel >/dev/null 2>&1 || die "--vercel given but vercel CLI not found — https://vercel.com/docs/cli"
  vset() { # vset <project> <VAR> <value>
    printf '%s' "$3" | vercel env add "$2" production --scope "${VERCEL_SCOPE:-}" --yes "$1" >/dev/null 2>&1 \
      || warn "  could not set $2 on $1 (may already exist — remove+re-add or set in dashboard)"
  }
  info "Syncing Vercel env vars (production)…"
  vset shell VITE_AUTH_URL "$AUTH_URL"; vset shell VITE_API_URL "$API_URL"; vset shell VITE_NOTIFY_API_URL "$NOTIFY_API_URL"
  vset shell ESTIMAI_REMOTE_URL "$ESTIMAI_REMOTE_URL"; vset shell REFUND_REMOTE_URL "$REFUND_REMOTE_URL"; vset shell ADMIN_REMOTE_URL "$ADMIN_REMOTE_URL"
  vset estimai-ui VITE_API_URL "$API_URL"; vset estimai-ui VITE_AUTH_URL "$AUTH_URL"; vset estimai-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  vset refund-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  vset admin-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  # notify-ui (specs/005): no backend var of its own — it goes through shell/session's
  # VITE_NOTIFY_API_URL (set on the shell project above), same pattern as admin-ui.
  vset notify-ui SHELL_REMOTE_URL "$SHELL_REMOTE_URL"
  for p in shell estimai-ui refund-ui admin-ui notify-ui; do vercel deploy --prod --cwd "$p" >/dev/null 2>&1 && ok "  redeployed $p" || warn "  redeploy $p failed — trigger from dashboard"; done
fi

echo ""
ok "Done. Verify with:  ./infra/check.sh"
echo "   Health:  railway status --service auth ; railway status --service estimai-api ; railway status --service notify-api"
echo "   Migrations + authz seed run automatically via each railway.json preDeployCommand."
