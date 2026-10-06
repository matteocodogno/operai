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
COPY --chown=bun:bun tsconfig.json prisma.config.ts ./

# Drop privileges: the official oven/bun:1.3-alpine image ships with a non-root
# 'bun' user (uid 1000). Running as root in a container handling regulated-sector
# financial and personal data (asset ledger, who holds which device) exceeds
# the risk floor — switch before the process starts.
USER bun

EXPOSE 8083

# DATA-RESIDENCY (specs/015-hardware-inventory): this image is deployed to
# Railway EU region only (europe-west4, see railway.json) — inventory-api
# handles financial figures and personal data (who holds which device).
# Request/response bodies are NEVER logged — only method+path+status
# (src/lib/logger.ts). Do NOT add any logger that includes body, query
# parameters with content, or the Prisma 'query' log level. Invoice files live
# in a SEPARATE EU-region bucket (INVENTORY_S3_*, ADR-0016 posture) reached
# only via presigned URLs.
#
CMD ["bun", "run", "src/index.ts"]
