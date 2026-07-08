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
-- Conventions (matches 055_research_foundation / 079_coldcall_core): gen_random_uuid()
-- PKs, tenant_id NOT NULL REFERENCES tenants ON DELETE CASCADE, created_by ->
-- auth.users, status TEXT + CHECK, JSONB default '{}', update_updated_at() trigger
-- (001_foundation.sql). Additive + re-runnable (IF NOT EXISTS).
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
-- NOTE (Faz-1 collision strategy — decided now, per critique P1-3): at CAPTURE time
-- member_urn is NULL, so two "new connection" captures can create two NULL-urn rows for
-- the SAME real identity. The Faz-1 validate handler MUST NOT do a plain UPDATE(member_urn):
-- it must either (a) pre-check (tenant_id, member_urn) and, on collision, fold/RESTRICT the
-- duplicate and surface "already connected to this workspace", or (b) upsert-merge onto the
-- canonical row. Otherwise the 2nd account to validate to the same identity hits 23505.
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
  -- Optional: re-auth an EXISTING account (NULL = new connection). Ownership is
  -- verified at issue time (route accounts.ts), so account_id always matches tenant_id.
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
  -- SET NULL (not CASCADE): preserve the append-only audit + COGS trail when an account
  -- is deleted — matches 055's preserve-financial-rows convention and job_id below.
  -- (tenant_id CASCADEs, so a tenant delete still removes everything.)
  account_id   UUID REFERENCES linkedin_accounts(id) ON DELETE SET NULL,
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
