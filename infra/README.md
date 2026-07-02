# TG-Research infra (Railway)

Self-hosted services for the TG-Research module, deployed to a **dedicated** Railway
project **`tg-research`** (separate from the CRM's `TG-Core` project).

> Integration status: as of this commit the engine's discovery path uses **Gemini
> grounding** (`server/src/lib/research/engine/discovery.ts`). SearXNG and Gosom are
> deployed and running but **not yet wired into the code** — they're the scale-stage
> search infra described in `Tg-Research-v2/00_MIMARI_PLAN.md`. Wire discovery to
> `SEARXNG_URL` / `GOSOM_URL` before they carry real traffic.

## Services

| Service | Source | Private endpoint | Purpose |
|---|---|---|---|
| `searxng` | `infra/searxng/` (Dockerfile) | `http://searxng.railway.internal:8080` | Multi-engine web search, JSON API |
| `gosom`   | `infra/gosom/` (Dockerfile)   | `http://gosom.railway.internal:8080`   | Google Maps business scraper, REST API |
| `worker`  | `deploy/worker/` (staged deploy) | (no port — background queue poller) | Runs research jobs (harvest, ICP, holds reaper, period grants) |

Private DNS (`*.railway.internal`) only resolves service-to-service within the same
project + environment. It is NOT reachable from a laptop.

## Deploy / redeploy

The project must be linked first: `railway link` → select `tg-research`.

```bash
# SearXNG (JSON API enabled via baked settings.yml; limiter off; no Valkey needed)
railway up infra/searxng --path-as-root --service searxng --detach

# Gosom (web mode; -c 1 bounds Chromium memory; /data is the job DB folder)
railway up infra/gosom --path-as-root --service gosom --detach
```

Verify (from inside the container, since private DNS is not laptop-reachable):

```bash
railway ssh --service searxng "wget -qO- 'http://localhost:8080/search?q=test&format=json' | head -c 200"
railway logs --service gosom --deployment --lines 20   # gosom image has no wget; check the banner
```

### Worker (see `deploy/worker/`)

The worker cannot deploy straight from repo root: the root `railway.json`/`railway.toml`
(`startCommand = npm start`, the web app) is config-as-code and always wins over any
Dockerfile CMD, and Railway exposes no CLI/GraphQL way to repoint a service's config
file. So the worker deploys from a **staged copy** whose root config is the worker's:

```bash
railway add --service worker
# set env (see contract below), then:
STAGE="$(mktemp -d)"
rsync -a --exclude .git --exclude node_modules --exclude 'server/dist' --exclude 'client/dist' ./ "$STAGE"/
cp deploy/worker/railway.json "$STAGE"/railway.json   # worker config becomes root config in the copy
rm -f "$STAGE"/railway.toml                            # remove the other root config
railway up "$STAGE" --path-as-root --service worker --detach
rm -rf "$STAGE"
```

## Worker env contract

Real variable names used by the code (not the generic ones):

- **Supabase (required):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.
  The research client (`server/src/lib/research/supabase.ts`) prefers
  `RESEARCH_SUPABASE_URL` + `RESEARCH_SUPABASE_SERVICE_ROLE_KEY` when set (Model B —
  dedicated research DB), else falls back to the shared `SUPABASE_*` (Model A).
  **The target DB must have research migrations 055–074 applied.**
- **LLM keys (required):** `CLAUDE_KEY` (ICP strategy), `GEMINI_KEY` (grounded discovery),
  `DEEPSEEK_KEY` (reading). Optional: `DEEPSEEK_BASE_URL` (defaults to api.deepseek.com).
- **Fetch (optional):** `JINA_KEY` — improves page-fetch reliability; without it the
  engine uses anonymous Jina Reader then falls back to guarded direct fetch.
- **Tuning (optional, have defaults):** `RESEARCH_WORKER_CONCURRENCY`, and the
  `RESEARCH_MAX_*_CEILING` / `RESEARCH_*` caps.

## Known issues / notes

- **`railway volume add` panics** in CLI 4.31 (`volume.rs` unwrap on None). Gosom's
  `/data` volume was skipped — its job DB is ephemeral across redeploys (fine while
  idle). Add the volume via the Railway dashboard if/when Gosom carries real jobs.
- **DataImpulse rotating proxy** for SearXNG is scaffolded but commented out in
  `infra/searxng/settings.yml`. Uncomment + add creds to enable IP rotation at scale.
- Image tags: SearXNG uses `:latest`, Gosom pins `v1.16.0`. Pin SearXNG to a dated
  tag once it's integrated and carrying traffic.
