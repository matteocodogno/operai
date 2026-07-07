#!/usr/bin/env bash
# infra/bootstrap.sh — idempotent Railway bootstrap for Operai (auth + estimai-api)
#
# PREREQUISITES
# ─────────────
# 1. railway CLI installed and authenticated (`railway login`).
# 2. Secrets exported in the current shell from 1Password (see infra/README.md).
#    The script fails loudly if any required secret env var is unset.
# 3. A Railway project already exists OR you want this script to create one.
#    Set RAILWAY_PROJECT_ID to target an existing project, or leave it unset
#    to create a new one named RAILWAY_PROJECT_NAME.
#
# DATA RESIDENCY: all services + the Postgres instance are pinned to europe-west4.
# This is a hard requirement for regulated-sector clients (CLAUDE.md).
#
# NEVER add real secret values to this file — it is committed to the repo.

set -euo pipefail

# ─── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[bootstrap]${NC} $*"; }
ok()    { echo -e "${GREEN}[bootstrap]${NC} $*"; }
warn()  { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
die()   { echo -e "${RED}[bootstrap] ERROR:${NC} $*" >&2; exit 1; }

# ─── Dependency checks ────────────────────────────────────────────────────────
command -v railway >/dev/null 2>&1 || die "railway CLI not found — install from https://docs.railway.app/develop/cli"
railway whoami >/dev/null 2>&1    || die "Not logged in to Railway — run: railway login"

# ─── Required secret env vars (read from the operator's shell — NEVER hardcoded) ─
# This repo uses direnv + 1Password: `cd auth/` and direnv exports these from
# `auth/.envrc` automatically. Run this script from within `auth/` (or otherwise
# ensure the vars below are exported). See infra/README.md for the full workflow.
REQUIRED_SECRETS=(
  BETTER_AUTH_SECRET
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  JWT_PRIVATE_KEY
  JWT_PUBLIC_KEY
)

info "Checking required secret env vars..."
for var in "${REQUIRED_SECRETS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    die "Required secret env var \$${var} is not set. Export it from 1Password before running this script (see infra/README.md)."
  fi
done
ok "All required secret env vars present."

# ─── Configuration (override via env if needed) ───────────────────────────────
RAILWAY_PROJECT_NAME="${RAILWAY_PROJECT_NAME:-operai}"
RAILWAY_ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
RAILWAY_REGION="europe-west4"

# UI origin — the deployed Vercel URL (no trailing slash for CORS)
UI_ORIGIN="${UI_ORIGIN:-https://operai.welld.io}"

# Public URL of the auth service (Railway-generated domain or a custom domain such
# as https://auth.operai.welld.io). Required — it becomes the JWT issuer, so both
# services must agree on it. Generate/attach the auth domain first, then set this.
AUTH_PUBLIC_URL="${AUTH_PUBLIC_URL:-}"
[[ -n "${AUTH_PUBLIC_URL}" ]] || die "AUTH_PUBLIC_URL is not set. Attach a domain to the auth service, then: export AUTH_PUBLIC_URL=https://<auth-domain>"

# ─── Project selection / creation ─────────────────────────────────────────────
if [[ -n "${RAILWAY_PROJECT_ID:-}" ]]; then
  info "Using existing Railway project: ${RAILWAY_PROJECT_ID}"
  railway environment use "${RAILWAY_ENVIRONMENT}" || \
    railway environment new "${RAILWAY_ENVIRONMENT}"
else
  info "Creating / selecting Railway project: ${RAILWAY_PROJECT_NAME}"
  # `railway init` is interactive; use `railway project new` if available,
  # otherwise prompt the operator to set RAILWAY_PROJECT_ID and re-run.
  die "RAILWAY_PROJECT_ID is not set. Create the project manually in the Railway dashboard (pinned to ${RAILWAY_REGION}), then set RAILWAY_PROJECT_ID=<id> and re-run."
fi

# ─── Postgres — single shared instance ───────────────────────────────────────
# Railway provisions one Postgres plugin; both services connect to it using
# separate logical databases ('auth' and 'estimai').
info "Checking for existing Postgres plugin..."
PG_EXISTS=$(railway service list 2>/dev/null | grep -i "postgres" | wc -l | tr -d ' ')

if [[ "${PG_EXISTS}" -eq 0 ]]; then
  info "Provisioning Postgres (eu) — this may take a moment..."
  railway add --plugin postgresql
  ok "Postgres provisioned."
else
  ok "Postgres plugin already present — skipping."
fi

# Retrieve connection variables from the Railway Postgres plugin.
# Railway exposes: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (default db).
# We use private networking (.railway.internal) for service-to-service traffic.
info "Reading Postgres connection vars from Railway..."
PGHOST_INTERNAL=$(railway variables get PGHOST --service postgresql 2>/dev/null || true)
PGPORT_VAL=$(railway variables get PGPORT --service postgresql 2>/dev/null || echo "5432")
PGUSER_VAL=$(railway variables get PGUSER --service postgresql 2>/dev/null || true)
PGPASSWORD_VAL=$(railway variables get PGPASSWORD --service postgresql 2>/dev/null || true)

if [[ -z "${PGHOST_INTERNAL}" || -z "${PGUSER_VAL}" || -z "${PGPASSWORD_VAL}" ]]; then
  die "Could not read Postgres connection vars from Railway. Ensure the Postgres plugin is provisioned and try again."
fi

# Prefer private networking host (ends in .railway.internal)
# Railway sets PGHOST to the private hostname automatically for internal services.
DB_HOST="${PGHOST_INTERNAL}"

# Superuser URL for DDL (create logical databases)
PG_ADMIN_URL="postgresql://${PGUSER_VAL}:${PGPASSWORD_VAL}@${DB_HOST}:${PGPORT_VAL}/postgres"

# ─── Create logical databases (idempotent) ────────────────────────────────────
# Postgres has no CREATE DATABASE IF NOT EXISTS. Use the gexec pattern:
#   SELECT 'CREATE DATABASE foo' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='foo')
# piped into psql to execute the result set.
info "Ensuring logical databases 'auth' and 'estimai' exist..."

for DBNAME in auth estimai; do
  railway run --service postgresql -- psql "${PG_ADMIN_URL}" -tc \
    "SELECT 'CREATE DATABASE ${DBNAME}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${DBNAME}')" \
    | railway run --service postgresql -- psql "${PG_ADMIN_URL}" \
    || warn "Could not auto-create database '${DBNAME}' via railway run — create it manually: CREATE DATABASE ${DBNAME};"
done

ok "Logical databases ready."

# ─── Compose per-service DATABASE_URLs ───────────────────────────────────────
DATABASE_URL_AUTH="postgresql://${PGUSER_VAL}:${PGPASSWORD_VAL}@${DB_HOST}:${PGPORT_VAL}/auth"
DATABASE_URL_ESTIMAI="postgresql://${PGUSER_VAL}:${PGPASSWORD_VAL}@${DB_HOST}:${PGPORT_VAL}/estimai"

# ─── Deploy auth service ──────────────────────────────────────────────────────
info "Configuring auth service variables..."
railway variables --service auth --set \
  "DATABASE_URL=${DATABASE_URL_AUTH}" \
  "BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}" \
  "BETTER_AUTH_URL=${AUTH_PUBLIC_URL}" \
  "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}" \
  "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}" \
  "GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}" \
  "GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}" \
  "JWT_PRIVATE_KEY=${JWT_PRIVATE_KEY}" \
  "JWT_PUBLIC_KEY=${JWT_PUBLIC_KEY}" \
  "ALLOWED_ORIGINS=${UI_ORIGIN}" \
  "UI_HOME_URL=${UI_ORIGIN}/" \
  "NODE_ENV=production"
# PORT is intentionally NOT set — Railway injects it and the app reads $PORT.
# ENABLE_TEST_AUTH is intentionally NOT set — it must remain absent in production.

info "Deploying auth service..."
railway up --service auth --detach
ok "auth service deployed."

# ─── Deploy estimai-api service ───────────────────────────────────────────────
# AUTH_ISSUER must equal the JWT 'iss' claim — better-auth sets iss = BETTER_AUTH_URL.
# AUTH_JWKS_URL uses /auth/jwks (better-auth's DB-keypair endpoint), NOT
# /.well-known/jwks.json (which serves the static env-var key — different keypair).
info "Configuring estimai-api service variables..."
railway variables --service estimai-api --set \
  "DATABASE_URL=${DATABASE_URL_ESTIMAI}" \
  "ALLOWED_ORIGINS=${UI_ORIGIN}" \
  "AUTH_ISSUER=${AUTH_PUBLIC_URL}" \
  "AUTH_JWKS_URL=${AUTH_PUBLIC_URL}/auth/jwks" \
  "NODE_ENV=production"
# PORT is intentionally NOT set — Railway injects it and the app reads $PORT.
# MAX_ESTIMATE_BYTES and MAX_IMPORT_REQUEST_BYTES use their coded defaults (1 MiB / 32 MiB).

info "Deploying estimai-api service..."
railway up --service estimai-api --detach
ok "estimai-api service deployed."

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
ok "Bootstrap complete."
echo ""
echo "  Verify deployments:"
echo "    railway status --service auth"
echo "    railway status --service estimai-api"
echo ""
echo "  Health checks (once DNS is live):"
echo "    curl ${AUTH_PUBLIC_URL}/health"
echo "    curl <API_URL>/health   # the estimai-api public domain"
echo ""
echo "  Migrations run automatically via preDeployCommand (bun run db:deploy)."
echo "  To roll back a migration: deploy the previous image tag from the Railway dashboard."
