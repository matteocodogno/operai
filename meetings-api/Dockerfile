# ─── Build stage ─────────────────────────────────────────────────────────────
# Generates the Prisma client inside the container so it matches the target.
FROM oven/bun:1.4-slim AS builder

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

RUN bun run node_modules/prisma/build/index.js generate

# ─── Production stage ─────────────────────────────────────────────────────────
# Debian (not alpine) because ffmpeg/ffprobe run inside this service (specs/021
# plan.md D-7, ADR-0064): the audio is normalised here, video never leaves it.
FROM oven/bun:1.4-slim AS production

WORKDIR /app

ENV NODE_ENV=production

# The ffmpeg package is PINNED: a codec or demuxer change must be a reviewed
# change here, not a surprise from `apt-get install` on the next build. Bump it
# together with the base image; the build fails loudly when the pin is gone from
# the Debian mirror.
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1
RUN apt-get update \
 && apt-get install -y --no-install-recommends "ffmpeg=${FFMPEG_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun --from=builder /app/src ./src
COPY --chown=bun:bun --from=builder /app/prisma ./prisma
COPY --chown=bun:bun tsconfig.json prisma.config.ts ./

# Non-root: this process handles recordings of meetings and decodes files
# uploaded by users. The official bun image ships a 'bun' user (uid 1000).
USER bun

EXPOSE 8085

# DATA-RESIDENCY (specs/021-meetings): deployed to Railway EU only (see
# railway.json), a single replica (the job runner and its LISTEN connection live
# in this process, ADR-0062). Request/response bodies and query strings are
# NEVER logged (src/lib/logger.ts): a title, a search term or a transcript is
# content. Do NOT add a logger that includes them, nor Prisma's 'query' level.
CMD ["bun", "run", "src/index.ts"]
