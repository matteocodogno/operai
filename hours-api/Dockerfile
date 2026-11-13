# ─── Build stage ─────────────────────────────────────────────────────────────
# Generates the Prisma client inside the container so the native query-engine
# binary matches the Linux target (not the developer's macOS build).
FROM oven/bun:1.4-alpine AS builder

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
FROM oven/bun:1.4-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies (as root so bun can write to /app)
COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

# Copy compiled source + generated Prisma client from builder
COPY --chown=bun:bun --from=builder /app/src ./src
COPY --chown=bun:bun --from=builder /app/prisma ./prisma
COPY --chown=bun:bun tsconfig.json prisma.config.ts ./

# Drop privileges: the official oven/bun image ships with a non-root 'bun' user
# (uid 1000). Running as root in a container handling records of who worked on what,
# every day, exceeds the risk floor — switch before the process starts.
USER bun

EXPOSE 8088

# DATA-RESIDENCY (specs/029-time-tracking): this image is deployed to Railway EU region
# only (europe-west4, see railway.json) — hours-api holds personal data about workers (which
# day each person spent how long on which project, deal or meeting) and the ids of the people
# (names are resolved live from auth, never stored). Request/response bodies are NEVER logged —
# only method+path+status (src/lib/logger.ts). Do NOT add any logger that includes body, query
# parameters (filters name people, projects and deals) or the Prisma 'query' log level.
#
CMD ["bun", "run", "src/index.ts"]
