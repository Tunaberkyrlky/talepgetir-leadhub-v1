# syntax=docker/dockerfile:1
# TG-Core STAGING — the FULL app (CRM + research + coldcall + linkedin UI/API) pointed
# at the ISOLATED test DB. One Node process serves the API and the built client (SPA
# fallback in server/src/index.ts). Used for LinkedIn/coldcall live smokes before prod.
# Build context is the REPO ROOT (a staged clean-HEAD copy, see infra/README.md).

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --include=dev
COPY server ./server
COPY client ./client
# Client needs no VITE_* build args: API base defaults to same-origin '/api';
# posthog/extension/log-level vars are optional.
RUN npm run build --workspace=server && npm run build --workspace=client

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./server/dist
# dist/index.js resolves the client at ../../client/dist relative to server/dist.
COPY --from=build /app/client/dist ./client/dist
WORKDIR /app/server
# Binds process.env.PORT (Railway injects it); /api/health is the healthcheck.
CMD ["node", "dist/index.js"]
