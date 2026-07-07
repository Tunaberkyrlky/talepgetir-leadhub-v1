# TG-Research infra (Railway)

Self-hosted services for the TG-Research module, deployed to a **dedicated** Railway
project **`tg-research`** (separate from the CRM's `TG-Core` project). TG-Research runs
fully isolated on its own research DB; the **only** touch-point to TG-Core prod is the
export handoff (writes qualified leads into the CRM `companies` table) and auth/identity.

## Services

| Service | Source | Endpoint | Purpose |
|---|---|---|---|
| `worker` | `deploy/worker/` (staged deploy) | (no port — queue poller) | Runs research jobs (harvest, ICP, Y2 trade ingest, holds reaper, grants). Discovery uses **SearXNG**. |
| `research-api` | `deploy/research-api/` (staged deploy) | `https://research-api-production-4d08.up.railway.app` | Standalone API: auth + tenants + `/api/research`. Export→prod. |
| `searxng` | `infra/searxng/` (Dockerfile) | `http://searxng.railway.internal:8080` | Multi-engine web search, JSON API. Discovery backend. |
| `gosom` | `infra/gosom/` (Dockerfile) | `http://gosom.railway.internal:8080` | Google Maps business scraper, REST API. Wired as the **`maps:harvest`** discovery backend (West). |
| `twogis` | `infra/twogis/` (Dockerfile) | `http://twogis.railway.internal:8080` | 2GIS Catalog-API scraper for the CIS (RU/KZ/UZ/…). Code exists but is **not active**; user decision is to skip 2GIS for now. |

Private DNS (`*.railway.internal`) only resolves service-to-service within the project.

## Two-database architecture

- **Research DB** (`researchSupabaseAdmin` → `RESEARCH_SUPABASE_URL`) — all research data.
  Never prod. Currently the `TG-Core-coldcrm-test` project (has migrations 055–078 for Research).
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
# 2GIS (CIS maps backend) is intentionally skipped for now; do not deploy or set TWOGIS envs
# unless this path is explicitly reopened.
# railway up infra/twogis  --path-as-root --service twogis  --detach
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
`RESEARCH_GOSOM_URL=http://gosom.railway.internal:8080` (enables the `maps:harvest` source —
unset ⇒ maps runs yield no candidates; tunables `RESEARCH_GOSOM_DEPTH` 10,
`RESEARCH_GOSOM_POLL_MS` 5000, `RESEARCH_GOSOM_MAX_WAIT_MS` 480000, `RESEARCH_GOSOM_MAX_RESULTS`
200, `RESEARCH_GOSOM_LANG` en, `RESEARCH_GOSOM_MAX_TIME_SEC` 300, `RESEARCH_GOSOM_PROXIES`),
`RESEARCH_TWOGIS_URL` must stay unset while 2GIS is skipped,
`JINA_KEY`, `RESEARCH_*` caps. **No prod creds** — worker never touches prod.

**research-api** — research DB (`RESEARCH_SUPABASE_URL` + key) **and** prod
(`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_ANON_KEY` from TG-Core, for
auth + export), `POSTHOG_API_KEY` + `POSTHOG_HOST` (required — `lib/posthog` instantiates
at import), `CLAUDE_KEY`/`GEMINI_KEY`/`DEEPSEEK_KEY`, `NODE_ENV=production`. Set
`RESEARCH_CLIENT_URL` (comma-sep origins) once a browser UI is deployed, or CORS blocks it.

## Discovery = SearXNG + rotating proxy

`server/src/lib/research/engine/discovery.ts` now runs deterministic SearXNG search when
`RESEARCH_SEARXNG_URL` is set: paginate → every result URL → registrable domain → drop
junk/aggregators (`domainFilter.ts`) → dedup → candidates. No LLM, $0 search; the LLM only
validates fitness. Gemini grounding is no longer the normal web-search path; fallback is limited to
SearXNG incomplete/error cases, and normal empty-result fallback is off unless
`RESEARCH_SEARXNG_GEMINI_FALLBACK_ON_EMPTY=1`.

SearXNG uses a Railway secret `ROTATING_PROXY` for residential/rotating egress. Do **not** put proxy
credentials in `settings.yml`: `infra/searxng/proxy-entrypoint.sh` strips CR/LF, prefixes `http://`
when the scheme is missing, writes a chmod-600 generated settings file under `/tmp`, and then starts
the upstream SearXNG entrypoint. SearXNG deploy `5f1ae282-e0b5-44f1-8fda-0a93451dfc77` is live.

Proxy smoke (inside the SearXNG container):

- `plumbing sanitary supplies Germany wholesalers distributors` → 30 results, 2 unresponsive engines.
- `Wer liefert was Sanitärbedarf Deutschland` → 30 results, 2 unresponsive engines.

Worker Y3 smoke with proxy, job `f1d4cce6-a1a7-481f-993a-1fec6286d7f0`: 33 queries, 610 raw
candidates, 317 unique candidates, all 11 angles x3, `searchUsd=0`, `totalGroundedQueries=0`.
Directory angle produced 69 results / 52 new domains; local-language produced 29 / 14. Credits stayed
8→8; the run stopped at the tiny validation cap and `fully_covered=false` because the last two
queries still found 9 new domains. Short audit smoke `bf39e9c5-76d4-4fba-93ee-8d0e81741db5`
confirmed `research_search_log.engine='searxng'` with 77 results and `$0` search cost.

## Maps discovery = `maps:harvest` (Gosom active, 2GIS skipped)

A second discovery **source** for the same harvest pipeline. `POST /api/research/harvest/run`
with `{"source":"maps"}` enqueues a `maps:harvest` job instead of the default web `harvest:run`.
The handler submits a scrape to a maps backend, polls for minutes (heartbeating so the lease stays
fresh), maps business rows to the engine's `Candidate` shape, then reuses the **identical**
downstream spine as web harvest — canonicalize → dedup → fetch → validate → persist → bill →
reconcile → settle — so every money invariant (reservation cap, lease fencing, KVKK suppression >
dedup, once-ever billing) holds. Backend is chosen by geography (`engine/scrapers/index.ts`, `pickMapsBackend`):
Gosom/Google Maps for the West. 2GIS/CIS code exists but is intentionally skipped; keep
`RESEARCH_TWOGIS_URL` unset and do not deploy the service. Both backends speak the same REST job contract via one shared client
factory (`engine/scrapers/httpScraper.ts`). A business with a website validates+bills like a web
hit; one without a site is parked domainless as `review` (its phone/address land in the enrichment
phase). Self-hosted scrape ⇒ $0 search; spend is entirely in validation, bounded by the run's caps.

## Y2 customs CSV = `trade:ingest`

`POST /api/research/trade/preview` normalizes a CSV without persisting it. The explicit
`/trade/import` call stores an auditable batch and queues `trade:ingest`; the worker seeds valid
buyers into `research_companies` as unbilled `review` rows with `source_path=Y2`. Missing buyers
are rejected, uncertain HS/country/value fields stay reviewable on `research_trade_imports`, and
suppression plus the company lease fence remain enforced. This data-only phase never reserves or
spends lead credits. ICP validation/billing is a separate, explicit future **Research** action.

## Known issues / notes

- **`railway volume add` needs the service linked first** (`railway service gosom`), else the
  CLI panics. Gosom's `/data` volume is created.
- Gosom v1.16.0 bundles playwright-go under `/opt/ms-playwright-go/1.57.0` but its base image
  points `PLAYWRIGHT_DRIVER_PATH` at `/opt`. `infra/gosom/Dockerfile` overrides the path; without
  it every job tries retired Playwright CDN URLs and remains stuck in `working`.
- SearXNG still reports intermittent per-engine CAPTCHA/too-many-requests even with proxy; the
  important invariant is that the proxy smoke did not use paid Gemini fallback (`searchUsd=0`).
- Image tags: SearXNG `:latest`, Gosom `v1.16.0`. Pin SearXNG once it carries real traffic.
