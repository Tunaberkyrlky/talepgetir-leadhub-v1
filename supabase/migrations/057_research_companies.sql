-- ==========================================
-- TG-Research v2 — Company ledger + contacts + trade ingest + messages + cache
-- research_companies is the core: the permanent, deduped, per-tenant company
-- ledger (K6). Both kept AND eliminated companies live here, each with a summary,
-- so a company is never re-scraped (and never re-billed — D2).
-- Suppression is first-class and outranks dedup (K9): a suppressed entity is
-- never re-added by the ledger.
-- RLS semantics identical to 055; applied via loop (see 056 for the pattern).
-- ==========================================

-- ------------------------------------------
-- COMPANIES — the dedup ledger. (tenant_id, domain) unique where domain present.
-- ------------------------------------------
CREATE TABLE research_companies (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Project where first discovered (the ledger itself is tenant-wide, not per-project).
  project_id         UUID REFERENCES research_projects(id) ON DELETE SET NULL,
  -- Normalized domain (app-side). NULL allowed for domainless map/list hits.
  domain             TEXT,
  name               TEXT NOT NULL,
  website            TEXT,
  country            TEXT,
  city               TEXT,
  status             TEXT NOT NULL DEFAULT 'review'
                     CHECK (status IN ('match','partial','eliminated','review')),
  score              INTEGER CHECK (score BETWEEN 0 AND 100),
  site_summary       TEXT,
  evidence           TEXT,
  elimination_reason TEXT,
  email              TEXT,
  phone              TEXT,
  icp_id             UUID REFERENCES research_icps(id) ON DELETE SET NULL,
  geo_id             UUID REFERENCES research_geographies(id) ON DELETE SET NULL,
  -- Which acquisition path found it: Y1 (list harvest), Y2 (customs), Y3 (open web).
  source_path        TEXT,
  channel_id         UUID REFERENCES research_channels(id) ON DELETE SET NULL,
  -- Billing: set once when this MATCH first consumes a lead credit (only MATCH is
  -- billed; dedup hits never re-bill — D1/D2).
  billed_at          TIMESTAMPTZ,
  -- Suppression (K9) — outranks dedup; never re-added once suppressed.
  suppressed         BOOLEAN NOT NULL DEFAULT false,
  suppressed_at      TIMESTAMPTZ,
  suppressed_reason  TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup key: one row per (tenant, domain) when a domain exists.
CREATE UNIQUE INDEX uq_research_companies_tenant_domain
  ON research_companies(tenant_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX idx_research_companies_tenant ON research_companies(tenant_id);
CREATE INDEX idx_research_companies_tenant_status ON research_companies(tenant_id, status);
CREATE INDEX idx_research_companies_project ON research_companies(project_id);
-- Suppression lookups (suppression > dedup check before insert).
CREATE INDEX idx_research_companies_suppressed
  ON research_companies(tenant_id, domain) WHERE suppressed = true;

-- ------------------------------------------
-- CONTACTS (FAZ E) — people at a company. Firm email = scrape; person = BetterEnrich.
-- ------------------------------------------
CREATE TABLE research_contacts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id        UUID NOT NULL REFERENCES research_companies(id) ON DELETE CASCADE,
  project_id        UUID REFERENCES research_projects(id) ON DELETE SET NULL,
  name              TEXT,
  title             TEXT,
  linkedin          TEXT,
  email             TEXT,
  email_status      TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (email_status IN ('verified','guessed','unknown')),
  phone             TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'scrape' CHECK (source IN ('scrape','betterenrich','manual')),
  suppressed        BOOLEAN NOT NULL DEFAULT false,
  suppressed_at     TIMESTAMPTZ,
  suppressed_reason TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_contacts_tenant ON research_contacts(tenant_id);
CREATE INDEX idx_research_contacts_company ON research_contacts(company_id);

-- ------------------------------------------
-- TRADE IMPORTS (B7/Y2) — uploaded customs data rows → candidate companies.
-- Manual CSV first, API later. duzenle.py content-cleaning is ported on top of this.
-- ------------------------------------------
CREATE TABLE research_trade_imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  company_name  TEXT,
  hs_codes      JSONB NOT NULL DEFAULT '[]',
  export_value  NUMERIC,
  website       TEXT,
  summary       TEXT,
  email         TEXT,
  phone         TEXT,
  raw           JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_trade_imports_tenant ON research_trade_imports(tenant_id);
CREATE INDEX idx_research_trade_imports_project ON research_trade_imports(project_id);

-- ------------------------------------------
-- MESSAGES (F1) — AI-assisted email drafts (per-ICP / per-company) before handoff.
-- ------------------------------------------
CREATE TABLE research_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  company_id  UUID REFERENCES research_companies(id) ON DELETE CASCADE,
  icp_id      UUID REFERENCES research_icps(id) ON DELETE SET NULL,
  subject     TEXT,
  body        TEXT,
  language    TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_messages_tenant ON research_messages(tenant_id);
CREATE INDEX idx_research_messages_project ON research_messages(project_id);

-- ==========================================
-- RLS + updated_at triggers for the tenant-scoped tables (standard set).
-- ==========================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'research_companies','research_contacts','research_trade_imports','research_messages'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = get_user_tenant_id() OR is_superadmin())',
      t || '_select', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK ((tenant_id = get_user_tenant_id() AND get_user_role() IN (''superadmin'',''ops_agent'',''client_admin'')) OR is_superadmin())',
      t || '_insert', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING ((tenant_id = get_user_tenant_id() AND get_user_role() IN (''superadmin'',''ops_agent'',''client_admin'')) OR is_superadmin())',
      t || '_update', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING ((tenant_id = get_user_tenant_id() AND get_user_role() IN (''superadmin'',''client_admin'')) OR is_superadmin())',
      t || '_delete', t);

    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      t || '_updated_at', t);
  END LOOP;
END $$;

-- ==========================================
-- SEARCH CACHE — query → result, time-bounded. Intentionally cross-tenant
-- (D12: only raw public-web cache is shared; no tenant data leaks). No tenant_id,
-- no policies → RLS enabled means service_role only (the worker). User-scoped
-- clients can never read it.
-- ==========================================
CREATE TABLE research_search_cache (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash  TEXT NOT NULL,
  query       TEXT NOT NULL,
  engine      TEXT NOT NULL DEFAULT 'searxng',
  result      JSONB NOT NULL DEFAULT '{}',
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE research_search_cache ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX uq_research_search_cache_key ON research_search_cache(engine, query_hash);
CREATE INDEX idx_research_search_cache_expires ON research_search_cache(expires_at);
