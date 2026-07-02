-- ==========================================
-- TG-Research v2 — Engine hardening (pre-engine, run while tables are empty)
-- Folds in the deferred items from the skeleton + LLM-router plan reviews, then a
-- two-reviewer (codex + adversarial workflow) pass. Items:
--   1. Canonical company identity        — dedup + billing key (not raw domain)
--   2. Verdict versioning per ICP         — eliminated ≠ never-rescored
--   3. Search cost ledger + page-fetch cache — per-tenant COGS + cross-tenant fetch cache
--   4. Idempotent + atomic billing        — one charge per canonical company per tenant, EVER,
--                                           billed only from a proven MATCH verdict, via one RPC
--   5. PII-free suppression registry      — suppression > dedup, enforced by trigger + RPC (KVKK)
--   6. Queue per-tenant fairness          — single-statement claim, no single tenant starves
--
-- Additive + re-runnable (IF NOT EXISTS / guarded DO blocks). Conventions mirror
-- 055–057: get_user_tenant_id() / get_user_role() / is_superadmin() / update_updated_at().
-- ==========================================


-- ============================================================================
-- PART 1 — CANONICAL COMPANY IDENTITY (dedup + billing key)
-- ----------------------------------------------------------------------------
-- The original dedup key was (tenant_id, domain) WHERE domain IS NOT NULL — which
-- (a) leaves domainless map/list hits un-deduped, and (b) ties billing to the raw
-- domain string (fragile across www / subdomain / multi-domain variants).
--
-- canonical_key is the stable identity the app computes for EVERY company:
--   • with a domain  → registrable domain (eTLD+1), lowercased, no "www."
--   • domainless     → 'name:' || normalized(name) || '|' || normalized(country|city)
-- It is the true dedup unit AND the billing unit (Part 4). Computed app-side (PSL +
-- normalization live in Node, not Postgres); the DB only enforces uniqueness.
-- NOTE (domainless lossiness): two genuinely different domainless firms that share a
-- normalized name+country collapse to one canonical_key (deduped + billed once). The
-- app SHOULD fold city/region into the domainless key to reduce false merges; billing
-- a single canonical_key once is intentional.
-- ============================================================================

ALTER TABLE research_companies ADD COLUMN IF NOT EXISTS canonical_key TEXT;

-- The runtime canonical_key (eTLD+1 / name|country) cannot be faithfully reproduced
-- in pure SQL, so we DO NOT silently backfill a divergent value (that would create
-- rows invisible to the dedup + bill-once guards). On the empty test DB there is
-- nothing to backfill; on a populated DB this refuses to proceed until the app
-- canonicalizer has filled canonical_key.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM research_companies WHERE canonical_key IS NULL) THEN
    RAISE EXCEPTION
      'research_companies has rows with NULL canonical_key; backfill via the app canonicalizer before applying 060';
  END IF;
END $$;

ALTER TABLE research_companies ALTER COLUMN canonical_key SET NOT NULL;

-- Replace the domain-only dedup key with the canonical key (covers domainless rows).
DROP INDEX IF EXISTS uq_research_companies_tenant_domain;
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_companies_tenant_canonical
  ON research_companies(tenant_id, canonical_key);
-- domain is still useful for lookups/joins, just no longer the unique key.
CREATE INDEX IF NOT EXISTS idx_research_companies_tenant_domain
  ON research_companies(tenant_id, domain) WHERE domain IS NOT NULL;

-- 057's suppressed-lookup index was on (tenant_id, domain); re-key it to the canonical
-- identity so it covers domainless suppressed rows and the new lookup path.
DROP INDEX IF EXISTS idx_research_companies_suppressed;
CREATE INDEX IF NOT EXISTS idx_research_companies_suppressed
  ON research_companies(tenant_id, canonical_key) WHERE suppressed = true;

-- Composite-FK targets: a UNIQUE CONSTRAINT (not just an index) on (tenant_id, id) so
-- child tables can reference (tenant_id, <id>) and structurally pin tenant ownership.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_research_companies_tenant_id') THEN
    ALTER TABLE research_companies ADD CONSTRAINT uq_research_companies_tenant_id UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_research_icps_tenant_id') THEN
    ALTER TABLE research_icps ADD CONSTRAINT uq_research_icps_tenant_id UNIQUE (tenant_id, id);
  END IF;
END $$;


-- ============================================================================
-- PART 2 — VERDICT VERSIONING PER ICP (eliminated ≠ never-rescored)
-- ----------------------------------------------------------------------------
-- Dedup means "never re-scrape a company we've seen" (its site_summary is cached).
-- It must NOT mean "its MATCH/ELIMINATED verdict is frozen forever": when the
-- customer edits an ICP during calibration (C2), ruleset_version bumps (app-side) and
-- every company can be re-scored FROM THE CACHED SUMMARY — cheap, no re-scrape.
-- research_companies.status/score stay the current rollup; verdicts are the per-ICP-
-- version source of truth, and the only thing billing is allowed to charge from (Part 4).
-- ============================================================================

ALTER TABLE research_icps
  ADD COLUMN IF NOT EXISTS ruleset_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS research_company_verdicts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  company_id         UUID NOT NULL,
  icp_id             UUID NOT NULL,
  -- The ICP ruleset this verdict was computed against (matches research_icps.ruleset_version).
  ruleset_version    INTEGER NOT NULL DEFAULT 1,
  verdict            TEXT NOT NULL CHECK (verdict IN ('match','partial','eliminated','review')),
  score              INTEGER CHECK (score BETWEEN 0 AND 100),
  evidence           TEXT,
  elimination_reason TEXT,
  -- Which model produced the verdict — eval/audit + COGS attribution.
  model              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Composite FKs pin tenant ownership: a verdict's tenant_id MUST equal the referenced
  -- company's AND icp's tenant_id, so a verdict can never be attributed (or leaked via RLS)
  -- to a tenant that does not own both. Cascade flows tenant→company→verdict.
  CONSTRAINT fk_research_verdict_company
    FOREIGN KEY (tenant_id, company_id) REFERENCES research_companies(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_research_verdict_icp
    FOREIGN KEY (tenant_id, icp_id) REFERENCES research_icps(tenant_id, id) ON DELETE CASCADE
);

-- tenant-led, one verdict per company per ICP per ruleset version (re-scoring under a
-- NEW ruleset_version inserts a new row; the same version upserts).
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_company_verdicts
  ON research_company_verdicts(tenant_id, company_id, icp_id, ruleset_version);
CREATE INDEX IF NOT EXISTS idx_research_company_verdicts_icp
  ON research_company_verdicts(tenant_id, icp_id, ruleset_version);


-- ============================================================================
-- PART 3 — SEARCH COST LEDGER + PAGE-FETCH CACHE
-- ----------------------------------------------------------------------------
-- research_search_cache (057) already caches query → results cross-tenant. Two gaps:
--   (a) per-tenant COGS attribution — Gemini grounding bills per executed query,
--       SearXNG/Gosom burn proxy bandwidth (margin panel, 01 §5 / D11).
--   (b) a page-fetch cache so a URL fetched once (Jina/Playwright) is not re-fetched.
-- ============================================================================

-- (a) Per-tenant search cost ledger (append-only). engine = gemini|searxng|gosom.
CREATE TABLE IF NOT EXISTS research_search_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES research_projects(id) ON DELETE SET NULL,
  job_id        UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  engine        TEXT NOT NULL,
  query         TEXT NOT NULL,
  query_hash    TEXT NOT NULL,
  result_count  INTEGER,
  cache_hit     BOOLEAN NOT NULL DEFAULT false,
  -- Attributed COGS in USD (0 on a cache hit). NUMERIC(12,6) = sub-cent precision.
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_research_search_log_tenant
  ON research_search_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_search_log_job
  ON research_search_log(job_id);

-- (b) Page-fetch cache. Cross-tenant like research_search_cache (raw public-web
-- content; no tenant data). RLS-enabled with NO policies → service-role only.
CREATE TABLE IF NOT EXISTS research_page_cache (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url_hash      TEXT NOT NULL,
  url           TEXT NOT NULL,
  -- HTTP status (or 0 for transport error) + how we got it: fetch|jina|playwright.
  status        INTEGER,
  fetch_method  TEXT,
  content       TEXT,
  content_hash  TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ
);
ALTER TABLE research_page_cache ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_page_cache_url ON research_page_cache(url_hash);
CREATE INDEX IF NOT EXISTS idx_research_page_cache_expires ON research_page_cache(expires_at);


-- ============================================================================
-- PART 4 — IDEMPOTENT + ATOMIC BILLING (the billing guard)
-- ----------------------------------------------------------------------------
-- Billing unit is LOCKED: one charge per unique canonical company per tenant, EVER,
-- and ONLY for a MATCH (01 §3 D1/D2: dedup + PARTIAL/ELIMINATED never bill).
--
-- All billing goes through research_bill_match() (below), the SOLE entry point. It is
-- a single transactional RPC so the billable-event insert and the usage_ledger
-- decrement cannot desync (the desync would silently give a MATCH away free or charge
-- twice). Direct INSERTs into this table by app code are a bug — use the RPC.
--
-- canonical_key (NOT company_id) is the uniqueness key on purpose: if the company row
-- is later hard-deleted for KVKK erasure, re-discovering the same firm STILL must not
-- re-charge. pricing_version is recorded for audit but intentionally NOT in the
-- uniqueness — "EVER" means once across all price books.
-- KVKK NOTE: an erasure must NOT delete research_billable_events. It carries no PII
-- beyond canonical_key and must outlive the PII row so re-discovery stays free.
-- ============================================================================

CREATE TABLE IF NOT EXISTS research_billable_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Nullable so the event survives a KVKK hard-delete of the company row.
  company_id      UUID REFERENCES research_companies(id) ON DELETE SET NULL,
  -- Immutable billing identity (Part 1). Survives company deletion.
  canonical_key   TEXT NOT NULL,
  pricing_version TEXT NOT NULL DEFAULT 'v1',
  unit            TEXT NOT NULL DEFAULT 'match_lead',
  -- Recorded charge in USD (the quota decrement itself lives in research_usage_ledger).
  amount_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  ledger_id       UUID REFERENCES research_usage_ledger(id) ON DELETE SET NULL,
  job_id          UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE idempotency guard: bill a canonical company at most once per tenant, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_billable_once
  ON research_billable_events(tenant_id, canonical_key);
CREATE INDEX IF NOT EXISTS idx_research_billable_events_tenant
  ON research_billable_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_billable_events_company
  ON research_billable_events(company_id);

-- Ties each ledger decrement to exactly one billable event → the decrement is itself
-- idempotent (a retry cannot double-decrement). Grants/top-ups use distinct refs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_usage_ledger_ref
  ON research_usage_ledger(ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;


-- ============================================================================
-- PART 5 — PII-FREE SUPPRESSION REGISTRY (suppression > dedup, KVKK erasure)
-- ----------------------------------------------------------------------------
-- The suppressed booleans on research_companies/contacts soft-block re-add but still
-- HOLD the PII. A KVKK erasure requires deleting the PII outright while still
-- guaranteeing "never re-add this entity". This registry is the durable guard:
--   • company → identity_key = canonical_key (a business identity, not personal data
--     under KVKK; same keyspace as dedup/billing, so the two CANNOT drift).
--   • contact → identity_key = sha256(lower(trim(email))) — email is personal data, so
--     only the one-way hash is stored; the PII row can be hard-deleted.
-- The company path is enforced structurally by a BEFORE INSERT trigger + inside the
-- billing RPC (no TOCTOU). The contact path is app-enforced for now (enrichment is the
-- last-priority phase); add a trigger when contacts land.
-- ============================================================================

CREATE TABLE IF NOT EXISTS research_suppression (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('company','contact')),
  -- company → canonical_key; contact → sha256(lower(trim(email))). No raw contact PII.
  identity_key  TEXT NOT NULL,
  reason        TEXT,
  source        TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('erasure_request','opt_out','bounce','manual')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_suppression
  ON research_suppression(tenant_id, entity_type, identity_key);

-- Hard DB invariant: a suppressed company can never be (re)inserted, regardless of
-- dedup state — turns "app checks the registry first" into a backstop with no TOCTOU.
-- Fires on plain INSERT and on the INSERT arm of INSERT ... ON CONFLICT. The app SHOULD
-- still pre-filter candidates so a single suppressed row doesn't abort a batch insert.
CREATE OR REPLACE FUNCTION research_block_suppressed_company()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = NEW.tenant_id
      AND entity_type = 'company'
      AND identity_key = NEW.canonical_key
  ) THEN
    RAISE EXCEPTION 'company is suppressed (suppression > dedup): tenant=% key=%',
      NEW.tenant_id, NEW.canonical_key USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_companies_suppression_guard ON research_companies;
CREATE TRIGGER research_companies_suppression_guard
  BEFORE INSERT ON research_companies
  FOR EACH ROW EXECUTE FUNCTION research_block_suppressed_company();


-- ============================================================================
-- RLS — tenant-scoped read, service-role write (mirrors usage_ledger/holds in 055)
-- The API + worker use the service-role key (bypasses RLS) and scope by tenant_id
-- manually. ENABLE + SELECT policy are applied together for all four tenant tables so
-- neither can be left with inert policies (RLS enabled but no policy = locked;
-- policies created but RLS off = fully exposed). research_page_cache stays policy-less
-- (service-role only); research_billable_events/usage_ledger are written ONLY by the
-- billing RPC, never by user-scoped clients.
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'research_company_verdicts','research_search_log',
    'research_billable_events','research_suppression'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = get_user_tenant_id() OR is_superadmin())',
      t || '_select', t);
  END LOOP;
END $$;


-- ============================================================================
-- BILLING RPC — research_bill_match(): the SOLE, atomic billing entry point.
-- ----------------------------------------------------------------------------
-- Charges a MATCH exactly once per (tenant, canonical company), ever. In one
-- transaction it: (1) resolves a verdict and PROVES verdict='match'; (2) takes a
-- per-tenant advisory lock so concurrent charges for the same tenant serialize (kills
-- the balance_after lost-update race across different companies); (3) refuses to bill a
-- suppressed company; (4) inserts the billable event under the bill-once guard; and
-- (5) only if that was the first charge, writes the usage_ledger decrement and links it.
-- Returns the billable event (existing one on a dedup hit — no ledger change).
-- NOTE: quota pre-checks / holds (block-before-run) happen UPSTREAM (before enqueue);
-- this RPC settles the realized MATCH.
-- ============================================================================
CREATE OR REPLACE FUNCTION research_bill_match(
  p_verdict_id      UUID,
  p_pricing_version TEXT    DEFAULT 'v1',
  p_amount_usd      NUMERIC DEFAULT 0,
  p_job_id          UUID    DEFAULT NULL
)
RETURNS research_billable_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant   UUID;
  v_company  UUID;
  v_canon    TEXT;
  v_verdict  TEXT;
  v_event    research_billable_events;
  v_balance  INTEGER;
  v_ledger   UUID;
BEGIN
  -- Resolve the verdict → tenant, company, canonical key — and PROVE it is a MATCH.
  SELECT v.tenant_id, v.company_id, v.verdict, c.canonical_key
    INTO v_tenant, v_company, v_verdict, v_canon
  FROM research_company_verdicts v
  JOIN research_companies c
    ON c.id = v.company_id AND c.tenant_id = v.tenant_id
  WHERE v.id = p_verdict_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_bill_match: verdict % not found', p_verdict_id;
  END IF;
  IF v_verdict <> 'match' THEN
    RAISE EXCEPTION 'research_bill_match: refusing to bill non-MATCH verdict % (verdict=%)',
      p_verdict_id, v_verdict USING ERRCODE = 'check_violation';
  END IF;

  -- Serialize all billing for this tenant (different tenants stay parallel).
  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || v_tenant::text));

  -- Suppression > dedup: never bill a suppressed firm.
  IF EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = v_tenant AND entity_type = 'company' AND identity_key = v_canon
  ) THEN
    RAISE EXCEPTION 'research_bill_match: refusing to bill suppressed company (tenant=%, key=%)',
      v_tenant, v_canon USING ERRCODE = 'check_violation';
  END IF;

  -- Bill once, ever.
  INSERT INTO research_billable_events
    (tenant_id, company_id, canonical_key, pricing_version, unit, amount_usd, job_id)
  VALUES
    (v_tenant, v_company, v_canon, p_pricing_version, 'match_lead', p_amount_usd, p_job_id)
  ON CONFLICT (tenant_id, canonical_key) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    -- Already billed (dedup) — return the existing event, no ledger change.
    SELECT * INTO v_event FROM research_billable_events
      WHERE tenant_id = v_tenant AND canonical_key = v_canon;
    RETURN v_event;
  END IF;

  -- First charge → decrement quota (idempotent via uq_research_usage_ledger_ref).
  SELECT balance_after INTO v_balance FROM research_usage_ledger
    WHERE tenant_id = v_tenant ORDER BY created_at DESC, id DESC LIMIT 1;
  v_balance := COALESCE(v_balance, 0) - 1;

  INSERT INTO research_usage_ledger (tenant_id, delta, reason, ref_type, ref_id, balance_after)
  VALUES (v_tenant, -1, 'match_lead', 'billable_event', v_event.id, v_balance)
  RETURNING id INTO v_ledger;

  UPDATE research_billable_events SET ledger_id = v_ledger
    WHERE id = v_event.id
    RETURNING * INTO v_event;

  RETURN v_event;
END;
$$;

-- SECURITY DEFINER + a bare GRANT leaves Postgres's default PUBLIC EXECUTE in place,
-- which would let anon/authenticated invoke this billing-mutation RPC via PostgREST.
-- Revoke PUBLIC first, then grant only the worker's service_role.
REVOKE ALL ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_bill_match(UUID, TEXT, NUMERIC, UUID) TO service_role;


-- ============================================================================
-- PART 6 — QUEUE PER-TENANT FAIRNESS (research_claim_job rewrite)
-- ----------------------------------------------------------------------------
-- The original claim ordered purely by (priority, scheduled_at): one tenant that
-- enqueues a deep backlog starves the others. The rewrite prefers the queued job whose
-- tenant currently has the FEWEST running jobs — round-robin-ish fairness — then falls
-- back to the original priority/age ordering.
--
-- Select + lock + update are now ONE statement (CTE with FOR UPDATE OF j SKIP LOCKED,
-- then UPDATE ... FROM that CTE), so the two-step SELECT-then-UPDATE EVALPLANQUAL gap
-- (which could return an empty claim while runnable jobs exist) is gone.
--
-- PERF/SEMANTICS NOTE: the fairness ORDER BY leads with a per-tenant aggregate, so the
-- 055 partial claim index no longer fully serves it and each poll sorts the eligible-
-- queued set; fairness is eventually-consistent (the running snapshot is a non-locked
-- MVCC read, self-correcting within ~1 poll). Fine at pilot concurrency. Fairness is
-- NOT a per-tenant concurrency cap — enforce any hard cap separately. Before scaling
-- backlog depth / worker fan-out, bound the sort (LATERAL top-K queued per tenant) or
-- maintain a stored per-tenant running_count the index can cover.
-- ============================================================================

-- Supports the per-tenant running-count aggregation in the claim CTE.
CREATE INDEX IF NOT EXISTS idx_research_jobs_running_tenant
  ON research_jobs(tenant_id) WHERE status = 'running';

CREATE OR REPLACE FUNCTION research_claim_job(
  p_worker_id TEXT,
  p_types     TEXT[] DEFAULT NULL
)
RETURNS SETOF research_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH running AS (
    SELECT tenant_id, count(*) AS n
    FROM research_jobs
    WHERE status = 'running'
    GROUP BY tenant_id
  ),
  candidate AS (
    SELECT j.id
    FROM research_jobs j
    LEFT JOIN running r ON r.tenant_id = j.tenant_id
    WHERE j.status = 'queued'
      AND j.scheduled_at <= now()
      AND (p_types IS NULL OR j.type = ANY(p_types))
    ORDER BY COALESCE(r.n, 0) ASC,      -- fairness: least-busy tenant first
             j.priority DESC,
             j.scheduled_at ASC,
             j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED
    LIMIT 1
  )
  UPDATE research_jobs j
  SET status       = 'running',
      attempts     = attempts + 1,
      locked_by    = p_worker_id,
      locked_at    = now(),
      heartbeat_at = now(),
      started_at   = COALESCE(started_at, now()),
      updated_at   = now()
  FROM candidate
  WHERE j.id = candidate.id
  RETURNING j.*;
END;
$$;

-- CREATE OR REPLACE preserves 058's existing revoke, but lock it explicitly anyway
-- (defense-in-depth: a SECURITY DEFINER queue mutator must never be PUBLIC-executable).
REVOKE ALL ON FUNCTION research_claim_job(TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_claim_job(TEXT, TEXT[]) TO service_role;
