# syntax=docker/dockerfile:1
# TG-Research worker — background queue poller (no HTTP port, no healthcheck).
# Build context is the REPO ROOT (a staged copy at deploy time, see deploy/worker/README).
# Builds ONLY the server workspace; client source is never copied.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Shared lockfile needs every workspace manifest present for `npm ci`.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --include=dev
# Build only the server workspace (its build script: tsc && cp -r src/data dist/data).
COPY server ./server
RUN npm run build --workspace=server

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./server/dist
# The worker resolves .env relative to the server workspace cwd; on Railway env is
# injected and no file exists, so run from server/ to match lib/supabase.ts cwd logic.
WORKDIR /app/server
CMD ["node", "dist/lib/research/worker/index.js"]
