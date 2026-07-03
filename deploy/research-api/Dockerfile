# syntax=docker/dockerfile:1
# TG-Research standalone API — serves only auth + tenants + /api/research.
# Build context is the REPO ROOT (a staged copy at deploy time, see deploy/research-api/).
# Same server build as the worker; different CMD. Binds $PORT with a /api/health check.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --include=dev
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
WORKDIR /app/server
# Binds process.env.PORT (Railway injects it); Express listens on 0.0.0.0 for the public edge.
CMD ["node", "dist/researchApi.js"]
