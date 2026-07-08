# TG-LinkedIn — Faz 0 Build Spec (Isolation + Skeleton)

> Status: **implementable, buildable in one pass.** 2026-07-08.
> Scope: Faz 0 only — isolation + skeleton that unblocks **Faz 1 (connect + validate)**.
> Source of truth: `00_STRATEJI_VE_MIMARI.md` (§7 architecture, §8 data model, §9 build plan) + the 6 convention maps.
> Every path below is **absolute-from-repo-root** `/Users/salihyetim/orca/workspaces/TG-Core-copy-16.06/TG-Research`.

---

## 0. Key decisions (read first)

1. **Migration number = `083`.** Highest existing is `082_coldcall_atomic_usage.sql` (the research series ended at 078; coldcall took 079–082). File: `supabase/migrations/083_linkedin_foundation.sql`. *(The secrets-map's "079+" guess predates the coldcall migrations — ignore it; 083 is correct.)*
2. **Three tables now, deny-all RLS.** `linkedin_accounts`, `linkedin_link_tokens`, `linkedin_actions`. Campaign/sequence/enrollment/leads/suppression tables are **deferred to a Faz-4 migration** (`084+`). All three Faz-0 tables use the **coldcall deny-all pattern** (`079_coldcall_core`): `ENABLE ROW LEVEL SECURITY` with **zero policies**, because `linkedin_accounts` holds encrypted session cookies (must be structurally unreachable by any client JWT) and `linkedin_actions` holds `cogs_usd` (COGS never reaches customers). 100% of access is service-role via the API, which shapes each response by role. `tenant_id` + index are kept for in-code scoping and a future policy add.
3. **Reuse the `research_jobs` queue verbatim — NO new queue, NO schema change.** `research_jobs.type` is free-form `TEXT`; `research_claim_job(worker, p_types)` with `p_types = NULL` claims **any** type. `linkedin:*` rows ride the existing queue.
4. **NO worker change.** `worker/index.ts` constructs the worker with **no `types` restriction** (`p_types → NULL`), so it already claims `linkedin:validate` the moment the handler is registered + the worker service redeploys. (Compiled in, not hot-loaded.) → **VERIFY live:** the deployed worker picks up a queued `linkedin:validate` after redeploy.
5. **Separate `/api/linkedin` router** (strategy §7 + routes-api map), **NOT** under `/api/research`. Isolation: two mount touch-points in `src/index.ts` (one public capture route pre-auth, one protected router post-auth). The **UI panel is a tab inside ResearchPage** (client map: keeps polling panels mounted) but its **data comes from `/api/linkedin/*`** — UI placement and API namespace are independent.
6. **Crypto: separate key domain.** New `server/src/lib/linkedin/crypto.ts` — identical AES-256-GCM blob format as `lib/encryption.ts` but keyed by `LINKEDIN_COOKIE_ENC_KEY` (fail-closed, no dev fallback) so a LinkedIn key rotation never touches SMTP/IMAP secrets.
7. **Sticky proxy: per-account `undici` `ProxyAgent`.** New leaf util `server/src/lib/linkedin/proxy.ts`; base credential in `ROTATING_5G_PROXY` secret env only, sticky session id injected into the proxy username. Adds `undici` to `server/package.json` (native `fetch` is undici-backed but `ProxyAgent` needs the package). Ready-but-only-consumed at Faz 1's real validate.

**Total: 16 files (10 new, 6 edited).** Worker = intentional no-op.

---

## 1. Ordered file manifest

| # | Path | New/Edit | What |
|---|---|---|---|
| 1 | `supabase/migrations/083_linkedin_foundation.sql` | NEW | 3 tables + deny-all RLS + indexes + updated_at trigger |
| 2 | `server/src/lib/linkedin/crypto.ts` | NEW | AES-256-GCM cookie encrypt/decrypt (`LINKEDIN_COOKIE_ENC_KEY`) |
| 3 | `server/src/lib/linkedin/proxy.ts` | NEW | sticky per-account `ProxyAgent` (`ROTATING_5G_PROXY`) |
| 4 | `server/package.json` | EDIT | add `"undici": "^7"` |
| 5 | `server/src/lib/research/jobTypes.ts` | EDIT | add `LINKEDIN_*` constants (validate live; rest reserved) |
| 6 | `server/src/lib/research/worker/handlers/linkedinValidate.ts` | NEW | `linkedin:validate` handler (Faz-0 stub) |
| 7 | `server/src/lib/research/worker/handlers/index.ts` | EDIT | register the validate handler |
| 8 | `server/src/routes/linkedin/accounts.ts` | NEW | list + health stub + link-token issue + enqueue-validate |
| 9 | `server/src/routes/linkedin/capture.ts` | NEW | public token-authed cookie capture |
| 10 | `server/src/routes/linkedin/index.ts` | NEW | router aggregation (protected sub-routers) |
| 11 | `server/src/index.ts` | EDIT | import + public capture mount + protected `/api/linkedin` mount |
| 12 | `.env.example` | EDIT | `LINKEDIN_COOKIE_ENC_KEY`, `ROTATING_5G_PROXY`, `LINKEDIN_APP_ORIGIN` |
| 13 | `client/src/components/linkedin/LinkedInAccountsPanel.tsx` | NEW | Mantine panel skeleton |
| 14 | `client/src/pages/research/ResearchPage.tsx` | EDIT | LinkedIn tab + panel |
| 15 | `client/src/locales/en.json` | EDIT | `research.tabs.linkedin` + `research.linkedin.*` |
| 16 | `client/src/locales/tr.json` | EDIT | same keys, TR values |

---

## 2. File 1 — `supabase/migrations/083_linkedin_foundation.sql` (NEW, full)

```sql
-- ==========================================
-- 083_linkedin_foundation.sql
-- TG-LinkedIn module — Faz 0 core tables (isolated namespace: linkedin_*)
--
-- Unblocks Faz 1 (connect + validate). Campaign / sequence_step / enrollment /
-- leads / suppression tables land in a LATER Faz-4 migration (084+).
--
-- RLS: DENY-ALL (mirror 079_coldcall_core — the newest, most analogous isolated
-- module). Every table here holds either encrypted session cookies
-- (linkedin_accounts.li_at_enc / jsessionid_enc — must be UNREACHABLE by any
-- client JWT) or COGS/health signal (linkedin_actions.cogs_usd — customers NEVER
-- see dollars). So each table ENABLEs RLS with ZERO policies: 100% of access is
-- service-role via the API/worker, which shapes the response by role. tenant_id +
-- index are kept for in-code scoping and a future user-scoped policy add.
--
-- Queue: NO new table. linkedin:* jobs ride the existing research_jobs queue
-- (055) via research_claim_job (type is free-form TEXT). linkedin_actions.job_id
-- references research_jobs so an action is traceable to the run that produced it.
--
-- Conventions (migrations-rls map): gen_random_uuid() PKs, tenant_id FK ON DELETE
-- CASCADE, created_by -> auth.users, status TEXT + CHECK, JSONB default '{}',
-- update_updated_at() trigger (001_foundation.sql). Additive + re-runnable-ish.
-- ==========================================

-- ── linkedin_accounts — one connected LinkedIn identity per tenant member ──────
-- Encrypted cookies + UA + sticky proxy session + warmup/health state.
CREATE TABLE IF NOT EXISTS linkedin_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id     UUID REFERENCES auth.users(id),      -- the team member who owns this session
  -- Session secrets: AES-256-GCM blobs (server/src/lib/linkedin/crypto.ts,
  -- LINKEDIN_COOKIE_ENC_KEY). Plaintext is NEVER stored or logged. csrf-token
  -- header value == the JSESSIONID cookie value (voyager "golden recipe", §4.1).
  li_at_enc         TEXT,
  jsessionid_enc    TEXT,
  -- Anti-detection (§3): capture the cookie's originating browser UA and send it
  -- VERBATIM on every voyager call; pin one sticky exit IP per account via the
  -- proxy_session_id injected into the ROTATING_5G_PROXY username.
  user_agent        TEXT,
  proxy_session_id  TEXT,                                -- random, minted on first capture; sticky forever
  geo               TEXT,                                -- account's usual country/city (IP geo-match)
  timezone          TEXT,                                -- IANA tz for working-hours scheduling (Faz 3)
  -- Identity resolved at validate (§4.3) — member_urn is the messaging mailboxUrn.
  member_urn        TEXT,                                -- urn:li:fsd_profile:<id>
  public_id         TEXT,                                -- vanity / public identifier
  name              TEXT,                                -- display label (member full name)
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','NEEDS_REAUTH','CHALLENGED','RESTRICTED','PAUSED')),
  warmup_day        INTEGER NOT NULL DEFAULT 0,          -- ramp position; persisted so a toggle can't reset it (§1)
  daily_counters    JSONB NOT NULL DEFAULT '{}',         -- {"date":"YYYY-MM-DD","invites":n,"messages":n,"visits":n}
  last_validated_at TIMESTAMPTZ,
  created_by        UUID REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linkedin_accounts_tenant ON linkedin_accounts(tenant_id);
-- One row per LinkedIn identity per tenant, but only once validated (member_urn set).
CREATE UNIQUE INDEX IF NOT EXISTS uq_linkedin_accounts_tenant_urn
  ON linkedin_accounts(tenant_id, member_urn) WHERE member_urn IS NOT NULL;

-- ── linkedin_link_tokens — single-use, HASHED, expiring extension-pairing tokens ─
-- The API issues a random raw token (returned ONCE to the client), stores only its
-- SHA-256 hash. The public capture endpoint hashes the presented token, atomically
-- claims the row (used_at IS NULL AND not expired), and derives tenant/user from it
-- (there is no req.tenantId pre-auth). RAW token is NEVER stored.
CREATE TABLE IF NOT EXISTS linkedin_link_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                     -- sha256 hex; raw token never persisted
  -- Optional: re-auth an EXISTING account (NULL = new connection).
  account_id   UUID REFERENCES linkedin_accounts(id) ON DELETE CASCADE,
  created_by   UUID REFERENCES auth.users(id),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linkedin_link_tokens_tenant ON linkedin_link_tokens(tenant_id);
-- Sweep/lookup hot-path: unconsumed tokens by expiry.
CREATE INDEX IF NOT EXISTS idx_linkedin_link_tokens_open
  ON linkedin_link_tokens(expires_at) WHERE used_at IS NULL;

-- ── linkedin_actions — append-only audit + rate-limit + health + COGS source ───
-- Every capture/validate/invite/message/poll/withdraw writes one row. Per-account
-- rate windows and health (§6 auto-pause) are computed by counting recent rows.
-- classifier is the NORMALIZED outcome (never trust http_status alone — §4.4).
CREATE TABLE IF NOT EXISTS linkedin_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id   UUID REFERENCES linkedin_accounts(id) ON DELETE CASCADE,
  lead_id      UUID,                                     -- no FK yet (linkedin_leads is Faz 4)
  type         TEXT NOT NULL
               CHECK (type IN ('capture','validate','invite','message','poll','withdraw','visit')),
  status       TEXT NOT NULL DEFAULT 'ok'
               CHECK (status IN ('ok','error','skipped')),
  http_status  INTEGER,                                  -- raw voyager HTTP status (advisory only)
  classifier   TEXT,                                     -- success|rate_limited|restricted|challenge|
                                                         -- already_connected|cant_resend_yet|session_invalid|unknown
  error        TEXT,
  cogs_usd     NUMERIC(10,4),                            -- proxy/LLM cost; INTERNAL roles only
  job_id       UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linkedin_actions_account
  ON linkedin_actions(account_id, created_at DESC);   -- rate-limit windows + health
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_tenant
  ON linkedin_actions(tenant_id, created_at DESC);

-- ── RLS: deny-all (ENABLE, zero policies) ──────────────────────────────────────
ALTER TABLE linkedin_accounts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_actions     ENABLE ROW LEVEL SECURITY;

-- ── updated_at trigger (only linkedin_accounts mutates in place) ───────────────
DROP TRIGGER IF EXISTS linkedin_accounts_updated_at ON linkedin_accounts;
CREATE TRIGGER linkedin_accounts_updated_at
  BEFORE UPDATE ON linkedin_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

**Apply to the ISOLATED research/test DB only** (prod clean). `linkedin_actions.job_id → research_jobs(id)` requires migration 055 present in the target DB (it is, on the research DB). **VERIFY live:** confirm the target DB has `research_jobs` + `update_updated_at()` before applying.

---

## 3. File 2 — `server/src/lib/linkedin/crypto.ts` (NEW, full)

```ts
/**
 * LinkedIn cookie encryption — AES-256-GCM.
 *
 * Blob format is IDENTICAL to lib/encryption.ts: base64( iv[12] || tag[16] || ct ),
 * but keyed by LINKEDIN_COOKIE_ENC_KEY (64 hex = 32 bytes) so a LinkedIn key
 * rotation never touches the CRM's SMTP/IMAP secrets (ENCRYPTION_KEY).
 *
 * Fail-closed, HARD: missing/malformed key -> AppError(500). No dev-fallback key —
 * these cookies carry account-takeover + PII weight, so there is never a silent
 * plaintext path. Plaintext is NEVER stored or logged — only the encrypted blob.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppError } from '../../middleware/errorHandler.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // GCM standard nonce
const TAG_LEN = 16;  // GCM auth tag

function getKey(): Buffer {
    const hex = process.env.LINKEDIN_COOKIE_ENC_KEY;
    if (!hex) throw new AppError('LINKEDIN_COOKIE_ENC_KEY not configured', 500);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new AppError('LINKEDIN_COOKIE_ENC_KEY must be 64 hex characters (32 bytes)', 500);
    }
    return Buffer.from(hex, 'hex');
}

export function isLinkedInEncryptionConfigured(): boolean {
    return !!process.env.LINKEDIN_COOKIE_ENC_KEY;
}

/** Encrypt a UTF-8 cookie value. Returns base64(iv || tag || ciphertext). */
export function encryptCookie(plain: string): string {
    const key = getKey();
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a base64(iv || tag || ciphertext) blob back to the original string. */
export function decryptCookie(blob: string): string {
    const key = getKey();
    const buf = Buffer.from(blob, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) throw new AppError('Encrypted cookie blob is malformed', 500);
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const d = createDecipheriv(ALGO, key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
```

---

## 4. File 3 — `server/src/lib/linkedin/proxy.ts` (NEW, full)

```ts
/**
 * Sticky per-account proxy (§3). LinkedIn flags rotating IPs as an obvious
 * automation signal, so each account must always exit from the SAME residential/5G
 * IP. The base credential lives ONLY in the ROTATING_5G_PROXY secret env (never in
 * DB / client / image); the per-account sticky session id is injected into the
 * proxy username so the upstream provider pins one egress IP per session.
 *
 * One ProxyAgent is cached per account for its lifetime so the keep-alive pool
 * (and thus the sticky IP) survives across requests. Pass the returned agent as the
 * `dispatcher` option to native fetch (or `{ dispatcher }` to undici.request) in the
 * Faz-1/2 ServerLinkedInClient.
 *
 * NOTE (VERIFY live at Faz 1): the sticky-session token syntax is provider-specific
 * (`-session-`, `-sessid-`, `-session:`…). Confirmed against ONE real 5G provider
 * before the first voyager call.
 */
import { ProxyAgent } from 'undici';

const agents = new Map<string, ProxyAgent>();

export function proxyAgentFor(proxySessionId: string): ProxyAgent {
    const cached = agents.get(proxySessionId);
    if (cached) return cached;

    const base = process.env.ROTATING_5G_PROXY;
    if (!base) throw new Error('ROTATING_5G_PROXY not configured');
    // base form: http(s)://USER:PASS@host:port  → inject sticky session into USER.
    const m = base.match(/^(https?:\/\/)([^:]+):([^@]+)@(.+)$/);
    if (!m) throw new Error('ROTATING_5G_PROXY must be http://USER:PASS@host:port');
    const [, scheme, user, pass, host] = m;
    const uri = `${scheme}${user}-session-${proxySessionId}:${pass}@${host}`;

    const agent = new ProxyAgent(uri);
    agents.set(proxySessionId, agent);
    return agent;
}

/** Mint a new sticky session id for a freshly captured account. */
export function newProxySessionId(): string {
    return `li_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
```

---

## 5. File 4 — `server/package.json` (EDIT)

Add one dependency (native `fetch` is undici-backed, but `ProxyAgent` needs the package). Insert alphabetically in `dependencies`:

```diff
+    "undici": "^7",
```

Then run `npm install` (root workspace). Node is v25 → undici `ProxyAgent` + the fetch `dispatcher` option are fully supported.

---

## 6. File 5 — `server/src/lib/research/jobTypes.ts` (EDIT, full new content)

Append the LinkedIn block inside `RESEARCH_JOB_TYPES` (before the closing `} as const;`). `validate` is live in Faz 1; the rest are **reserved constants** (known but unhandled — the worker fails a reserved type cleanly with "No handler registered", and no Faz-0 route enqueues them).

```ts
export const RESEARCH_JOB_TYPES = {
    PING: 'ping',
    /** ICP Master (B5): generate ICP drafts from the project profile via the strategy model. */
    ICP_GENERATE: 'icp:generate',
    /** Y1 list-harvest (capped pilot): discover → validate → bill MATCHes for 1 ICP × 1 geo. */
    HARVEST_RUN: 'harvest:run',
    /** Maps-harvest: async maps scrape (Gosom/Google Maps; 2GIS/CIS in M2) → same harvest pipeline. */
    MAPS_HARVEST: 'maps:harvest',
    /** Y2: normalized customs buyers -> unbilled review candidates in the company ledger. */
    TRADE_INGEST: 'trade:ingest',
    /** Y2 explicit Research: imported buyers -> shared validation + MATCH-only billing. */
    TRADE_HARVEST: 'trade:harvest',

    // ── TG-LinkedIn (isolated module; rides this same queue) ──────────────────
    /** LinkedIn: session liveness + UA/proxy health smoke (/voyager/api/me). Faz 1. */
    LINKEDIN_VALIDATE: 'linkedin:validate',
    /** RESERVED (Faz 2+): single connection invite (quota-hold + lease-fenced). */
    LINKEDIN_INVITE: 'linkedin:invite',
    /** RESERVED (Faz 2+): single 1st-degree message (post-accept / sequence step). */
    LINKEDIN_MESSAGE: 'linkedin:message',
    /** RESERVED (Faz 4): accept/reply detection poll (periodic). */
    LINKEDIN_POLL: 'linkedin:poll',
    /** RESERVED (Faz 4): sequence-engine scheduler tick. */
    LINKEDIN_SEQUENCE_TICK: 'linkedin:sequence-tick',
    /** RESERVED (Faz 3): withdraw a stale pending invite. */
    LINKEDIN_WITHDRAW: 'linkedin:withdraw',
} as const;
```

(`ResearchJobType`, `RESEARCH_JOB_TYPE_VALUES`, `isKnownJobType` auto-derive via `Object.values` — no other edit in this file.)

---

## 7. File 6 — `server/src/lib/research/worker/handlers/linkedinValidate.ts` (NEW, full stub)

Faz-0 stub that **proves the API→queue→worker→DB loop** for `linkedin:validate` and writes the audit row, WITHOUT making a real voyager call (that is Faz 1). It must not falsely assert a session is healthy: it records a `skipped` action and does **not** promote status.

```ts
/**
 * linkedin:validate — session liveness + UA/proxy health (§4/§6).
 *
 * FAZ 0: STUB. Proves the loop (payload → load account → heartbeat → audit row →
 * result) and is idempotent. It does NOT hit the network and does NOT promote
 * account.status. Fleshed out in Faz 1 (see TODO below).
 *
 * Follows the mapsHarvest/harvestRun template: service-role client, tenant-scoped
 * writes, heartbeat for long work, throw to fail, return a JSON summary.
 */
import type { JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:linkedin-validate');

export const linkedinValidateHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    const accountId = typeof job.payload?.account_id === 'string' ? job.payload.account_id : null;
    if (!accountId) throw new Error('linkedin:validate requires payload.account_id');

    // Fence identity — a claimed job always carries these (see harvestRun).
    const worker = job.locked_by;
    const lease = job.lease;
    if (!worker || !lease) throw new Error(`linkedin:validate: job ${job.id} has no running lease`);

    await heartbeat({ stage: 'validating', account_id: accountId });

    // Load the account (tenant-scoped). Must exist and belong to this tenant.
    const { data: account, error: loadErr } = await researchSupabaseAdmin
        .from('linkedin_accounts')
        .select('id, status, proxy_session_id, user_agent, li_at_enc, jsessionid_enc')
        .eq('id', accountId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (loadErr) throw loadErr;
    if (!account) throw new Error(`linkedin:validate: account ${accountId} not found for tenant ${tenantId}`);

    // ── TODO(Faz 1): real validation ──────────────────────────────────────────
    //   1. decryptCookie(li_at_enc) + decryptCookie(jsessionid_enc)  (lib/linkedin/crypto)
    //   2. agent = proxyAgentFor(account.proxy_session_id)           (lib/linkedin/proxy)
    //   3. GET /voyager/api/me with the golden-recipe headers + captured user_agent,
    //      { dispatcher: agent, signal: AbortSignal.timeout(20_000) }; never-throw wrap.
    //   4. classify per §4.4 (200 → ACTIVE + fill member_urn/public_id/name;
    //      401/expired → NEEDS_REAUTH; 403/999/restrict → CHALLENGED/RESTRICTED).
    //   5. UPDATE linkedin_accounts SET status, last_validated_at, member_urn, ...
    // ──────────────────────────────────────────────────────────────────────────

    // Faz-0: record a 'skipped' audit row; do NOT change status.
    const { error: auditErr } = await researchSupabaseAdmin.from('linkedin_actions').insert({
        tenant_id: tenantId,
        account_id: accountId,
        type: 'validate',
        status: 'skipped',
        classifier: 'faz0_stub',
        job_id: job.id,
    });
    if (auditErr) throw auditErr;

    log.info({ jobId: job.id, accountId }, 'linkedin:validate (faz0 stub) complete');
    return { account_id: accountId, stub: true, status: (account as { status: string }).status };
};
```

---

## 8. File 7 — `server/src/lib/research/worker/handlers/index.ts` (EDIT, full new content)

Two additions: the import and the map entry.

```ts
/**
 * Handler registry — maps research_jobs.type → handler.
 * Register new job handlers here (and add the type to lib/research/jobTypes.ts).
 */
import type { JobHandler } from '../types.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';
import { pingHandler } from './ping.js';
import { icpGenerateHandler } from './icpGenerate.js';
import { harvestRunHandler } from './harvestRun.js';
import { mapsHarvestHandler } from './mapsHarvest.js';
import { tradeIngestHandler } from './tradeIngest.js';
import { tradeHarvestHandler } from './tradeHarvest.js';
import { linkedinValidateHandler } from './linkedinValidate.js';

const handlers: Record<string, JobHandler> = {
    [RESEARCH_JOB_TYPES.PING]: pingHandler,
    [RESEARCH_JOB_TYPES.ICP_GENERATE]: icpGenerateHandler,
    [RESEARCH_JOB_TYPES.HARVEST_RUN]: harvestRunHandler,
    [RESEARCH_JOB_TYPES.MAPS_HARVEST]: mapsHarvestHandler,
    [RESEARCH_JOB_TYPES.TRADE_INGEST]: tradeIngestHandler,
    [RESEARCH_JOB_TYPES.TRADE_HARVEST]: tradeHarvestHandler,
    [RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE]: linkedinValidateHandler,
};

export function getHandler(type: string): JobHandler | undefined {
    return handlers[type];
}

/** Job types the worker can currently run. */
export function registeredJobTypes(): string[] {
    return Object.keys(handlers);
}
```

> **Worker (`server/src/lib/research/worker/index.ts`): NO EDIT.** It builds the worker with no `types` restriction → `research_claim_job(p_types = NULL)` → claims any queued type including `linkedin:validate`. Confirmed in the queue-worker map. **VERIFY live** after redeploy.

---

## 9. File 8 — `server/src/routes/linkedin/accounts.ts` (NEW — skeleton)

Authenticated router (mounted under `/api/linkedin`, behind `authMiddleware`). All reads use the service-role `researchSupabaseAdmin` scoped by `req.tenantId` and **never select `*_enc` columns** (deny-all keeps them off PostgREST anyway; the API also never echoes them).

**Endpoints**
- `GET /accounts` → list this tenant's accounts (safe columns only).
- `GET /accounts/:id/health` → status + counters + last-N action classifier counts (stub).
- `POST /accounts/link-token` → issue single-use pairing token (returns raw token ONCE + deep link URL).
- `POST /accounts/:id/validate` → enqueue `linkedin:validate` for an existing account.

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { randomBytes, createHash } from 'crypto';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';

const log = createLogger('route:linkedin:accounts');
const router = Router();
const requireWriter = requireRole('superadmin', 'ops_agent', 'client_admin');

// Never selects li_at_enc / jsessionid_enc — encrypted cookies never leave the server.
const SAFE_COLUMNS =
    'id, name, public_id, status, warmup_day, geo, timezone, daily_counters, last_validated_at, created_at';

// ── GET /accounts — list this tenant's connected accounts ─────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { data, error } = await researchSupabaseAdmin
            .from('linkedin_accounts')
            .select(SAFE_COLUMNS)
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });
        if (error) throw new AppError('Failed to list LinkedIn accounts', 500);
        res.json({ data: data ?? [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'list accounts error');
        next(new AppError('Failed to list LinkedIn accounts', 500));
    }
});

// ── GET /accounts/:id/health — status + recent-action rollup (Faz-0 stub) ─────
router.get('/:id/health', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const id = req.params.id;
        if (!uuidField().safeParse(id).success) { res.status(400).json({ error: 'Invalid id' }); return; }

        const { data: account, error } = await researchSupabaseAdmin
            .from('linkedin_accounts')
            .select(SAFE_COLUMNS)
            .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (error) throw new AppError('Failed to read health', 500);
        if (!account) { res.status(404).json({ error: 'Account not found' }); return; }

        // Last 20 actions → classifier counts (Faz 3 turns this into the health signal).
        const { data: actions } = await researchSupabaseAdmin
            .from('linkedin_actions')
            .select('type, status, classifier, created_at')
            .eq('tenant_id', tenantId).eq('account_id', id)
            .order('created_at', { ascending: false }).limit(20);

        res.json({ account, recent_actions: actions ?? [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'health error');
        next(new AppError('Failed to read health', 500));
    }
});

// ── POST /accounts/link-token — issue a single-use extension-pairing token ─────
const linkTokenSchema = z.object({ account_id: uuidField('Invalid account_id').optional() });
router.post('/link-token', requireWriter, validateBody(linkTokenSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { account_id } = req.body as z.infer<typeof linkTokenSchema>;

        // Raw token returned ONCE; only its SHA-256 hash is stored.
        const raw = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(raw).digest('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

        const { error } = await researchSupabaseAdmin.from('linkedin_link_tokens').insert({
            tenant_id: tenantId,
            token_hash: tokenHash,
            account_id: account_id ?? null,
            created_by: req.user?.id ?? null,
            expires_at: expiresAt.toISOString(),
        });
        if (error) throw new AppError('Failed to issue link token', 500);

        // Deep link the MV3 extension opens to capture cookies + POST them back.
        const origin = process.env.LINKEDIN_APP_ORIGIN || process.env.CLIENT_URL || '';
        const url = `${origin}/linkedin/connect#token=${raw}`;
        res.status(201).json({ token: raw, url, expires_at: expiresAt.toISOString() });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'link-token error');
        next(new AppError('Failed to issue link token', 500));
    }
});

// ── POST /accounts/:id/validate — enqueue a liveness check ─────────────────────
router.post('/:id/validate', requireWriter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const id = req.params.id;
        if (!uuidField().safeParse(id).success) { res.status(400).json({ error: 'Invalid id' }); return; }

        const { data: account } = await researchSupabaseAdmin
            .from('linkedin_accounts').select('id')
            .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        if (!account) { res.status(404).json({ error: 'Account not found' }); return; }

        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE,
            payload: { account_id: id },
            maxAttempts: 1,             // non-idempotent network probe; operator re-runs on failure
            createdBy: req.user?.id ?? null,
        });
        res.status(202).json(job);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'enqueue validate error');
        next(new AppError('Failed to enqueue validation', 500));
    }
});

export default router;
```

---

## 10. File 9 — `server/src/routes/linkedin/capture.ts` (NEW — skeleton)

**Public** router (mounted BEFORE `authMiddleware`, own limiter). The browser extension can't send the httpOnly session cookie cross-site, so this is authenticated purely by the single-use link token. Do **NOT** trust `req.tenantId` (none pre-auth) — derive tenant/user from the atomically-claimed token row.

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { createHash } from 'crypto';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody } from '../../lib/validation.js';
import { encryptCookie } from '../../lib/linkedin/crypto.js';
import { newProxySessionId } from '../../lib/linkedin/proxy.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';

const log = createLogger('route:linkedin:capture');
const router = Router();

const captureSchema = z.object({
    token: z.string().min(32).max(128),
    li_at: z.string().min(1).max(4000),
    jsessionid: z.string().min(1).max(4000),
    user_agent: z.string().min(1).max(1000),
    geo: z.string().max(120).optional().nullable(),
    timezone: z.string().max(64).optional().nullable(),
});

// ── POST /api/linkedin/capture — extension posts captured cookies + UA ─────────
router.post('/', validateBody(captureSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const body = req.body as z.infer<typeof captureSchema>;
        const tokenHash = createHash('sha256').update(body.token).digest('hex');

        // Atomically CLAIM the single-use token (used_at IS NULL AND not expired).
        const now = new Date().toISOString();
        const { data: claimed, error: claimErr } = await researchSupabaseAdmin
            .from('linkedin_link_tokens')
            .update({ used_at: now })
            .eq('token_hash', tokenHash)
            .is('used_at', null)
            .gt('expires_at', now)
            .select('tenant_id, account_id, created_by')
            .maybeSingle();
        if (claimErr) throw new AppError('Capture failed', 500);
        if (!claimed) { res.status(401).json({ error: 'Invalid, used, or expired token' }); return; }

        const tenantId = (claimed as { tenant_id: string }).tenant_id;
        const existingAccountId = (claimed as { account_id: string | null }).account_id;
        const createdBy = (claimed as { created_by: string | null }).created_by;

        const li_at_enc = encryptCookie(body.li_at);
        const jsessionid_enc = encryptCookie(body.jsessionid);

        let accountId: string;
        if (existingAccountId) {
            // Re-auth an existing account (keep its sticky proxy_session_id).
            const { error } = await researchSupabaseAdmin.from('linkedin_accounts')
                .update({
                    li_at_enc, jsessionid_enc, user_agent: body.user_agent,
                    geo: body.geo ?? null, timezone: body.timezone ?? null,
                    status: 'ACTIVE',
                })
                .eq('id', existingAccountId).eq('tenant_id', tenantId);
            if (error) throw new AppError('Capture failed', 500);
            accountId = existingAccountId;
        } else {
            const { data: inserted, error } = await researchSupabaseAdmin.from('linkedin_accounts')
                .insert({
                    tenant_id: tenantId, owner_user_id: createdBy, created_by: createdBy,
                    li_at_enc, jsessionid_enc, user_agent: body.user_agent,
                    geo: body.geo ?? null, timezone: body.timezone ?? null,
                    proxy_session_id: newProxySessionId(),
                    status: 'ACTIVE',
                })
                .select('id').single();
            if (error) throw new AppError('Capture failed', 500);
            accountId = (inserted as { id: string }).id;
        }

        // Audit + kick a liveness check.
        await researchSupabaseAdmin.from('linkedin_actions').insert({
            tenant_id: tenantId, account_id: accountId, type: 'capture', status: 'ok', classifier: 'success',
        });
        await enqueueJob({
            tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE,
            payload: { account_id: accountId }, maxAttempts: 1, createdBy,
        });

        res.status(201).json({ ok: true, account_id: accountId });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'capture error');
        next(new AppError('Capture failed', 500));
    }
});

export default router;
```

---

## 11. File 10 — `server/src/routes/linkedin/index.ts` (NEW, full)

Mirrors `routes/research/index.ts` — aggregates the **protected** sub-routers only. The public capture router is mounted separately in `src/index.ts`.

```ts
/**
 * TG-LinkedIn module router — mounted at /api/linkedin (auth applied upstream).
 * Isolated module boundary: the only touch-points to the rest of the server are
 * TWO mount lines in src/index.ts (this protected router + the public capture
 * router). The module never mutates CRM tables.
 */
import { Router } from 'express';
import accountsRouter from './accounts.js';

const router = Router();

router.use('/accounts', accountsRouter);

export default router;
```

---

## 12. File 11 — `server/src/index.ts` (EDIT — integration diff)

Three inserts. **Import** (next to line 39–40, after `researchRoutes`):

```diff
 import researchRoutes from './routes/research/index.js';
+import linkedinRoutes from './routes/linkedin/index.js';
+import linkedinCaptureRoutes from './routes/linkedin/capture.js';
 import coldcallRoutes from './coldcall/routes/index.js';
```

**Dedicated limiter** (add near the other limiters, ~line 164 — the extension posts unauthenticated, so rate-limit it hard):

```diff
+const linkedinCaptureLimiter = rateLimit({
+    windowMs: 60 * 1000,
+    limit: 20,
+    standardHeaders: true,
+    legacyHeaders: false,
+    message: { error: 'Too many capture requests' },
+});
```

**Public capture mount** — in the public block (after the webhook mounts, ~line 197, BEFORE `authMiddleware`):

```diff
 app.use('/api/webhooks', webhookLimiter, webhooksRoutes);
+
+// LinkedIn cookie capture — public, authenticated by a single-use link token
+// (the MV3 extension can't send the session cookie cross-site). No authMiddleware.
+app.use('/api/linkedin/capture', linkedinCaptureLimiter, linkedinCaptureRoutes);
```

**Protected mount** — right after the research mount (line 220):

```diff
 app.use('/api/research', authMiddleware, researchRoutes);
+
+// TG-LinkedIn module (isolated). Auth only for now; caps/limits arrive in Faz 3.
+// The public capture endpoint is mounted above, before authMiddleware.
+app.use('/api/linkedin', authMiddleware, linkedinRoutes);
```

> **Ordering matters:** the public `/api/linkedin/capture` mount must come BEFORE `app.use('/api/linkedin', authMiddleware, …)`. Express matches in order, so a more specific public path registered first wins; otherwise `authMiddleware` would reject the extension's tokenless POST.

---

## 13. File 12 — `.env.example` (EDIT)

Append a LinkedIn block (near the `ENCRYPTION_KEY` block, ~line 67):

```bash
# ── TG-LinkedIn ─────────────────────────────────────────────────────────────
# Cookie encryption key — separate domain from ENCRYPTION_KEY so a LinkedIn key
# rotation never touches SMTP/IMAP secrets. 64 hex chars (openssl rand -hex 32).
# Fail-closed: if unset, every capture/validate returns 500 (no plaintext path).
LINKEDIN_COOKIE_ENC_KEY=

# Sticky residential/5G proxy base credential (per-account exit IP is pinned by
# injecting proxy_session_id into the username). Secret env ONLY — never in DB or
# image. Form: http://USER:PASS@host:port
ROTATING_5G_PROXY=

# Origin the extension deep-links to for cookie capture (falls back to CLIENT_URL).
LINKEDIN_APP_ORIGIN=
```

> `ROTATING_5G_PROXY` and `LINKEDIN_COOKIE_ENC_KEY` are set as **Railway secrets** on the worker + API services (not committed). `LINKEDIN_COOKIE_ENC_KEY` is per-environment and **unrecoverable if lost** (all encrypted cookies become garbage).

---

## 14. File 13 — `client/src/components/linkedin/LinkedInAccountsPanel.tsx` (NEW — skeleton)

Isolated under `components/linkedin/` (strategy §7). Rendered as a tab in ResearchPage. Calls the **`/linkedin/*`** API (not `/research/linkedin/*`). `api` baseURL is `/api`, and tenant/auth headers are injected transparently.

```tsx
import { Alert, Badge, Button, Group, Loader, Paper, Stack, Table, Text } from '@mantine/core';
import { IconBrandLinkedin, IconInfoCircle, IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';

type LinkedInStatus = 'ACTIVE' | 'NEEDS_REAUTH' | 'CHALLENGED' | 'RESTRICTED' | 'PAUSED';
interface LinkedInAccount {
    id: string;
    name: string | null;
    public_id: string | null;
    status: LinkedInStatus;
    warmup_day: number;
    last_validated_at: string | null;
}

const STATUS_COLOR: Record<LinkedInStatus, string> = {
    ACTIVE: 'green', NEEDS_REAUTH: 'orange', CHALLENGED: 'yellow', RESTRICTED: 'red', PAUSED: 'gray',
};

export default function LinkedInAccountsPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const accountsQuery = useQuery<{ data: LinkedInAccount[] }>({
        queryKey: ['linkedin', 'accounts'],
        queryFn: async () => (await api.get('/linkedin/accounts')).data,
        // Poll while any account is still resolving (freshly captured, not yet validated).
        refetchInterval: (q) =>
            q.state.data?.data?.some((a) => a.status === 'ACTIVE' && !a.last_validated_at) ? 3000 : false,
    });
    const accounts = accountsQuery.data?.data ?? [];

    // Connect: issue a single-use link token + deep link; the extension captures cookies.
    const connectMut = useMutation({
        mutationFn: async () => (await api.post('/linkedin/accounts/link-token', {})).data as { url: string },
        onSuccess: ({ url }) => {
            if (url) window.open(url, '_blank', 'noopener');
            showSuccess(t('research.linkedin.tokenIssued', 'Pairing link opened — capture your session in the extension.'));
            qc.invalidateQueries({ queryKey: ['linkedin', 'accounts'] });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md">
                <Group justify="space-between">
                    <Text fw={600}>{t('research.linkedin.heading', 'LinkedIn Accounts')}</Text>
                    <Button leftSection={<IconPlus size={16} />} onClick={() => connectMut.mutate()} loading={connectMut.isPending}>
                        {t('research.linkedin.connect', 'Connect account')}
                    </Button>
                </Group>
            </Paper>

            <Paper withBorder radius="md" p="md">
                {accountsQuery.isLoading ? (
                    <Group justify="center" py="xl"><Loader /></Group>
                ) : accountsQuery.isError ? (
                    <Alert color="red" icon={<IconInfoCircle size={16} />}>
                        {t('research.linkedin.loadFailed', 'Could not load LinkedIn accounts')}
                    </Alert>
                ) : accounts.length === 0 ? (
                    <Text c="dimmed" ta="center" py="xl">
                        {t('research.linkedin.empty', 'No accounts connected yet.')}
                    </Text>
                ) : (
                    <Table striped highlightOnHover verticalSpacing="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('research.linkedin.account', 'Account')}</Table.Th>
                                <Table.Th ta="center">{t('research.linkedin.status', 'Status')}</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {accounts.map((a) => (
                                <Table.Tr key={a.id}>
                                    <Table.Td>
                                        <Group gap={6} wrap="nowrap">
                                            <IconBrandLinkedin size={16} />
                                            <Text size="sm" fw={600}>{a.name ?? a.public_id ?? a.id}</Text>
                                        </Group>
                                    </Table.Td>
                                    <Table.Td ta="center">
                                        <Badge variant="filled" color={STATUS_COLOR[a.status] ?? 'gray'}>
                                            {t(`research.linkedin.statusValue.${a.status}`, a.status)}
                                        </Badge>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                )}
            </Paper>
        </Stack>
    );
}
```

> **VERIFY:** `showSuccess` is exported from `client/src/lib/notifications` (harvest/CompaniesPanel use `showErrorFromApi` + `showSuccess`). If not, drop the `showSuccess` line.

---

## 15. File 14 — `client/src/pages/research/ResearchPage.tsx` (EDIT — integration diff)

Three inserts. **Import** (top, ~line 20, after `TradeImportsPanel`):

```diff
 import TradeImportsPanel from '../../components/research/TradeImportsPanel';
+import LinkedInAccountsPanel from '../../components/linkedin/LinkedInAccountsPanel';
```

Add `IconBrandLinkedin` to the tabler import on line 12:

```diff
-import { IconSparkles, IconInfoCircle, IconBuildingSkyscraper, IconTargetArrow, IconFileSpreadsheet } from '@tabler/icons-react';
+import { IconSparkles, IconInfoCircle, IconBuildingSkyscraper, IconTargetArrow, IconFileSpreadsheet, IconBrandLinkedin } from '@tabler/icons-react';
```

**Tab** in `Tabs.List` (after the `trade` tab, ~line 125):

```diff
                         <Tabs.Tab value="trade" leftSection={<IconFileSpreadsheet size={16} />}>
                             {t('research.tabs.trade', 'Customs data')}
                         </Tabs.Tab>
+                        <Tabs.Tab value="linkedin" leftSection={<IconBrandLinkedin size={16} />}>
+                            {t('research.tabs.linkedin', 'LinkedIn Accounts')}
+                        </Tabs.Tab>
                     </Tabs.List>
```

**Panel** (alongside the other `Tabs.Panel`s, ~line 134):

```diff
                     <Tabs.Panel value="trade">
                         <TradeImportsPanel />
                     </Tabs.Panel>
+
+                    <Tabs.Panel value="linkedin">
+                        <LinkedInAccountsPanel />
+                    </Tabs.Panel>
```

> No `App.tsx` change: the LinkedIn surface is a tab under the existing `/research` route. A standalone deep-linkable `/linkedin` route is **deferred** (add only if the extension deep link must land on a dedicated page — the `#token` pairing page is served by the extension flow, not a React route, in Faz 1).

---

## 16. Files 15 + 16 — i18n (`en.json` + `tr.json`, EDIT)

Both files have `research.tabs` at line 511. Two edits per file: add the tab label, and add a sibling `research.linkedin` namespace. Key shapes MUST be identical across both files.

**`client/src/locales/en.json`** — add `"linkedin"` to `research.tabs`:

```diff
         "tabs": {
             "icp": "ICP Master",
             "companies": "Leads",
-            "trade": "Customs data"
+            "trade": "Customs data",
+            "linkedin": "LinkedIn Accounts"
         },
```

…and add the `research.linkedin` object (as a sibling of `research.tabs`, e.g. right after `tabs`):

```json
        "linkedin": {
            "heading": "LinkedIn Accounts",
            "connect": "Connect account",
            "tokenIssued": "Pairing link opened — capture your session in the extension.",
            "empty": "No accounts connected yet.",
            "loadFailed": "Could not load LinkedIn accounts",
            "account": "Account",
            "status": "Status",
            "statusValue": {
                "ACTIVE": "Active",
                "NEEDS_REAUTH": "Reconnect needed",
                "CHALLENGED": "Verification",
                "RESTRICTED": "Restricted",
                "PAUSED": "Paused"
            }
        },
```

**`client/src/locales/tr.json`** — same shape, Turkish values:

```diff
         "tabs": {
             "icp": "ICP Master",
             "companies": "Leads",
-            "trade": "Gümrük Verisi"
+            "trade": "Gümrük Verisi",
+            "linkedin": "LinkedIn Hesapları"
         },
```

```json
        "linkedin": {
            "heading": "LinkedIn Hesapları",
            "connect": "Hesap bağla",
            "tokenIssued": "Eşleme bağlantısı açıldı — oturumunuzu uzantıda yakalayın.",
            "empty": "Henüz bağlı hesap yok.",
            "loadFailed": "LinkedIn hesapları yüklenemedi",
            "account": "Hesap",
            "status": "Durum",
            "statusValue": {
                "ACTIVE": "Aktif",
                "NEEDS_REAUTH": "Yeniden bağlanın",
                "CHALLENGED": "Doğrulama",
                "RESTRICTED": "Kısıtlı",
                "PAUSED": "Duraklatıldı"
            }
        },
```

> **VERIFY:** the `trade` value on the removed line matches the current file exactly (en: `"Customs data"`, tr: `"Gümrük Verisi"`) before applying the trailing-comma edit.

---

## 17. Integration points checklist (every touch)

| Integration point | File | Line anchor | Action |
|---|---|---|---|
| Queue table | (none) | — | Reuse `research_jobs`; no schema change |
| Claim RPC | (none) | — | `research_claim_job(p_types=NULL)` already claims `linkedin:*` |
| Job type constants | `jobTypes.ts` | inside `RESEARCH_JOB_TYPES` | add `LINKEDIN_*` |
| Handler registry | `handlers/index.ts` | import + `handlers` map | add `linkedinValidateHandler` |
| Worker poll set | `worker/index.ts` | — | **NO EDIT** (no `types` restriction) — VERIFY live |
| Server import | `index.ts` | ~L39 | `linkedinRoutes` + `linkedinCaptureRoutes` |
| Public capture mount | `index.ts` | ~L197 (pre-auth) | `/api/linkedin/capture` + `linkedinCaptureLimiter` |
| Protected mount | `index.ts` | ~L220 (post-auth) | `/api/linkedin` behind `authMiddleware` |
| Crypto key | `.env.example` + Railway | — | `LINKEDIN_COOKIE_ENC_KEY` |
| Proxy secret | `.env.example` + Railway | — | `ROTATING_5G_PROXY` |
| undici dep | `server/package.json` | dependencies | `"undici": "^7"` + `npm install` |
| Client panel import | `ResearchPage.tsx` | ~L20 | `LinkedInAccountsPanel` |
| Client tab + panel | `ResearchPage.tsx` | ~L125 / ~L134 | `value="linkedin"` |
| i18n tab label | `en.json` + `tr.json` | `research.tabs` | `linkedin` |
| i18n namespace | `en.json` + `tr.json` | sibling of `research.tabs` | `research.linkedin.*` |

---

## 18. VERIFY-live before Faz 1 (do not skip)

1. **Migration target = isolated research/test DB**, prod clean. Confirm `research_jobs` + `update_updated_at()` exist there, then apply `083`.
2. **Worker redeploy picks up `linkedin:validate`.** Enqueue via `POST /api/linkedin/accounts/:id/validate`, watch the worker claim + succeed, and confirm a `linkedin_actions(type='validate', classifier='faz0_stub')` row lands.
3. **`npm install` after adding `undici`** (server workspace) — build fails otherwise (proxy.ts imports it).
4. **Env set on BOTH API and worker services:** `LINKEDIN_COOKIE_ENC_KEY` (64 hex), `ROTATING_5G_PROXY`, `LINKEDIN_APP_ORIGIN`. Missing enc key → capture/validate 500 (fail-closed by design).
5. **Deny-all read check:** a tenant user JWT hitting `linkedin_accounts` directly via PostgREST returns **zero rows** (RLS enabled, no policy). API `/accounts` returns data because it uses service role.
6. **Capture ordering:** `curl -XPOST /api/linkedin/capture` (no auth cookie) must reach the token handler (401 on bad token), NOT `authMiddleware` (which would 401 before the body is parsed). Confirms the public mount precedes the protected mount.
7. **`showSuccess` export** in `client/src/lib/notifications` (else drop that line).
8. **Proxy sticky-session token syntax** (`-session-` vs provider-specific) against ONE real 5G provider before the first real voyager call (Faz 1 flesh-out of `linkedinValidate`).

---

## 19. Explicitly DEFERRED (not Faz 0)

- Tables: `linkedin_leads`, `linkedin_suppression`, `linkedin_campaigns`, `linkedin_sequence_steps`, `linkedin_enrollments` → **Faz-4 migration `084+`**.
- `ServerLinkedInClient` + `engine/voyager.ts` hot-update surface + profile-URN resolver → **Faz 2**.
- Real `/voyager/api/me` call, cookie decrypt, status promotion, identity fill in `linkedinValidate` → **Faz 1**.
- MV3 extension itself (cookie capture + POST to `/api/linkedin/capture`) → **Faz 1** (server endpoint is ready now).
- Quota holds / warmup ramp / working-hours / jitter / withdraw → **Faz 3**.
- Reserved job handlers (`invite`/`message`/`poll`/`sequence-tick`/`withdraw`) → **Faz 2–4** (constants reserved now).
```