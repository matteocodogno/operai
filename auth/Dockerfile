# ─── Build stage ─────────────────────────────────────────────────────────────
# Generates the Prisma client inside the container so the native query-engine
# binary matches the Linux target (not the developer's macOS build).
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Install dependencies (exact lockfile, production + dev needed for prisma generate)
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Copy source + Prisma schema
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client for the linux/alpine target
RUN bun run node_modules/prisma/build/index.js generate

# ─── Production stage ─────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies (as root so bun can write to /app)
COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

# Copy compiled source + generated Prisma client from builder
COPY --chown=bun:bun --from=builder /app/src ./src
COPY --chown=bun:bun --from=builder /app/prisma ./prisma

# One-off operator script (specs/20261117-legal-entities T9/T12): the copy of the CRM's legal details into the registry,
# run by hand inside this image (`bun run scripts/import-crm-legal-details.ts`, infra/README.md § Legal entities rollout,
# step 3), never by the CMD below. It imports ../src/** (copied above) and nothing else, so only this file is copied: not
# scripts/e2e-invite-fixtures.ts, a test fixture. It reads CRM_DATABASE_URL and DATABASE_URL from the environment only.
COPY --chown=bun:bun scripts/import-crm-legal-details.ts ./scripts/import-crm-legal-details.ts
COPY --chown=bun:bun tsconfig.json prisma.config.ts ./

# Drop privileges: the official oven/bun:1.3-alpine image ships with a non-root
# 'bun' user (uid 1000). Running as root in a container handling regulated-sector
# data exceeds the risk floor — switch before the process starts.
USER bun

# Run migrations then start the server.
# The CMD is intentionally a shell form so the entrypoint can be overridden
# (e.g. compose `command:` can substitute the healthcheck or a one-off migration).
EXPOSE 3001

# DATA-RESIDENCY: this image is deployed to Railway EU region only.
# Request/response bodies are NEVER logged — hono/logger emits method+path+status only.
# Do NOT add any logger that includes request bodies or the Prisma 'query' log level.
CMD ["bun", "run", "src/index.ts"]
