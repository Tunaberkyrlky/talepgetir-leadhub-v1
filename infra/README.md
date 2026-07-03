# TG-Research infra (Railway)

Self-hosted services for the TG-Research module, deployed to a **dedicated** Railway
project **`tg-research`** (separate from the CRM's `TG-Core` project). TG-Research runs
fully isolated on its own research DB; the **only** touch-point to TG-Core prod is the
export handoff (writes qualified leads into the CRM `companies` table) and auth/identity.

## Services

| Service | Source | Endpoint | Purpose |
|---|---|---|---|
| `worker` | `deploy/worker/` (staged deploy) | (no port — queue poller) | Runs research jobs (harvest, ICP, holds reaper, grants). Discovery uses **SearXNG**. |
| `research-api` | `deploy/research-api/` (staged deploy) | `https://research-api-production-4d08.up.railway.app` | Standalone API: auth + tenants + `/api/research`. Export→prod. |
| `searxng` | `infra/searxng/` (Dockerfile) | `http://searxng.railway.internal:8080` | Multi-engine web search, JSON API. Discovery backend. |
| `gosom` | `infra/gosom/` (Dockerfile) | `http://gosom.railway.internal:8080` | Google Maps business scraper, REST API. (Maps-discovery adapter TBD.) |

Private DNS (`*.railway.internal`) only resolves service-to-service within the project.

## Two-database architecture

- **Research DB** (`researchSupabaseAdmin` → `RESEARCH_SUPABASE_URL`) — all research data.
  Never prod. Currently the `TG-Core-coldcrm-test` project (has migrations 055–074).
- **CRM prod DB** (`supabaseAdmin` → `SUPABASE_URL`) — used ONLY for auth/identity
  (memberships) and the export write (`companies`). The single bridge to TG-Core prod.

The **worker** never loads the CRM client (`freshRole`/`lib/supabase` are route-only), so it
is provably prod-isolated. The **research-api** holds prod creds because it serves auth +
the export route.

## Deploy / redeploy

Project must be linked: `railway link -p fdd120c4-5e6b-4503-aae6-8b0ec84304d9 -e production`.

```bash
# SearXNG (JSON API via baked settings.yml; limiter off; no Valkey)
railway up infra/searxng --path-as-root --service searxng --detach
# Gosom (web mode; -c 1 bounds Chromium memory; /data volume for the job DB)
railway up infra/gosom   --path-as-root --service gosom   --detach
```

Verify (private DNS isn't laptop-reachable — exec inside the container):

```bash
railway ssh --service searxng "wget -qO- 'http://localhost:8080/search?q=test&format=json' | head -c 200"
railway logs --service gosom --deployment --lines 20   # gosom image has no wget; check the banner
```

### worker & research-api (staged-archive deploy)

Both build the whole `server` workspace from the repo root but need a start command that
differs from the repo-root `railway.json` (`npm start` = the web app, config-as-code that
can't be repointed by CLI). So each deploys from a **staged copy** whose root config is its
own (`deploy/<svc>/railway.json` → `deploy/<svc>/Dockerfile`):

```bash
STAGE="$(mktemp -d)"
rsync -a --exclude .git --exclude node_modules --exclude 'server/dist' --exclude 'client/dist' \
  --exclude .env --exclude 'Tg-Research-v1-bakis' --exclude '*.tsbuildinfo' ./ "$STAGE"/
cp deploy/worker/railway.json "$STAGE"/railway.json   # (or deploy/research-api/railway.json)
rm -f "$STAGE"/railway.toml
railway up "$STAGE" --path-as-root --service worker --detach   # (or --service research-api)
rm -rf "$STAGE"
```

## Env contract (real variable names)

**worker** — `RESEARCH_SUPABASE_URL` + `RESEARCH_SUPABASE_SERVICE_ROLE_KEY` (research DB),
`RESEARCH_SEARXNG_URL=http://searxng.railway.internal:8080`, `CLAUDE_KEY`, `GEMINI_KEY`,
`DEEPSEEK_KEY`. Optional: `RESEARCH_SEARXNG_PAGES` (5), `RESEARCH_SEARXNG_ENGINES`,
`JINA_KEY`, `RESEARCH_*` caps. **No prod creds** — worker never touches prod.

**research-api** — research DB (`RESEARCH_SUPABASE_URL` + key) **and** prod
(`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_ANON_KEY` from TG-Core, for
auth + export), `POSTHOG_API_KEY` + `POSTHOG_HOST` (required — `lib/posthog` instantiates
at import), `CLAUDE_KEY`/`GEMINI_KEY`/`DEEPSEEK_KEY`, `NODE_ENV=production`. Set
`RESEARCH_CLIENT_URL` (comma-sep origins) once a browser UI is deployed, or CORS blocks it.

## Discovery = SearXNG (Gemini grounding dropped)

`server/src/lib/research/engine/discovery.ts` now runs deterministic SearXNG search when
`RESEARCH_SEARXNG_URL` is set: paginate → every result URL → registrable domain → drop
junk/aggregators (`domainFilter.ts`) → dedup → candidates. No LLM, $0 search; the LLM only
validates fitness. Gemini grounding remains as a fallback only when SearXNG is unconfigured.

## Known issues / notes

- **`railway volume add` needs the service linked first** (`railway service gosom`), else the
  CLI panics. Gosom's `/data` volume is created.
- **DataImpulse rotating proxy** for SearXNG is scaffolded but commented out in
  `infra/searxng/settings.yml`. Uncomment + add creds for IP rotation at scale.
- Image tags: SearXNG `:latest`, Gosom `v1.16.0`. Pin SearXNG once it carries real traffic.
