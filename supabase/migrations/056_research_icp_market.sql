-- ==========================================
-- TG-Research v2 — ICP & market planning (FAZ B)
-- HS codes, markets (TradeMap), ICPs, geographies, channels, chunks.
-- RLS policy semantics are identical to 055_research_foundation.sql
-- (see research_projects there for the canonical explicit form). Here the
-- standard tenant-scoped self-serve policy set is applied via a loop to avoid
-- dozens of copy-pasted, typo-prone policy blocks.
-- ==========================================

-- ------------------------------------------
-- HS CODE candidates (B1) — physical-product → HS code, customer approves.
-- ------------------------------------------
CREATE TABLE research_hs_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','approved','rejected')),
  source      TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','manual')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_hs_codes_tenant ON research_hs_codes(tenant_id);
CREATE INDEX idx_research_hs_codes_project ON research_hs_codes(project_id);

-- ------------------------------------------
-- MARKETS (B2) — TradeMap scrape output: top importing countries per HS code.
-- ------------------------------------------
CREATE TABLE research_markets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  hs_code_id    UUID REFERENCES research_hs_codes(id) ON DELETE SET NULL,
  hs_code       TEXT,
  country       TEXT NOT NULL,
  import_value  NUMERIC,
  growth_pct    NUMERIC,
  rank          INTEGER,
  source        TEXT NOT NULL DEFAULT 'trademap',
  raw           JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_markets_tenant ON research_markets(tenant_id);
CREATE INDEX idx_research_markets_project ON research_markets(project_id);

-- ------------------------------------------
-- ICP MASTER (B5) — segments, signals, elimination rules, lookalikes, /10 score.
-- ------------------------------------------
CREATE TABLE research_icps (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id          UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  code                TEXT,
  segment             TEXT,
  signals             JSONB NOT NULL DEFAULT '[]',
  negative_signals    JSONB NOT NULL DEFAULT '[]',
  neutral_signals     JSONB NOT NULL DEFAULT '[]',
  elimination_rules   JSONB NOT NULL DEFAULT '[]',
  lookalike_companies JSONB NOT NULL DEFAULT '[]',
  -- Human /10 calibration score (B5). NULL until the customer scores it.
  human_score         INTEGER CHECK (human_score BETWEEN 0 AND 10),
  note                TEXT,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_icps_tenant ON research_icps(tenant_id);
CREATE INDEX idx_research_icps_project ON research_icps(project_id);

-- ------------------------------------------
-- GEOGRAPHIES (B3) — ICP × geography cell with the coverage estimate (E).
-- ------------------------------------------
CREATE TABLE research_geographies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  icp_id      UUID REFERENCES research_icps(id) ON DELETE CASCADE,
  country     TEXT NOT NULL,
  region      TEXT,
  estimate    INTEGER,
  confidence  NUMERIC,
  rationale   TEXT,
  human_score INTEGER CHECK (human_score BETWEEN 0 AND 10),
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_geographies_tenant ON research_geographies(tenant_id);
CREATE INDEX idx_research_geographies_project ON research_geographies(project_id);

-- ------------------------------------------
-- CHANNELS (Y1 — list harvest) — discovered company-list sources per sector×country.
-- ------------------------------------------
CREATE TABLE research_channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  icp_id          UUID REFERENCES research_icps(id) ON DELETE SET NULL,
  geo_id          UUID REFERENCES research_geographies(id) ON DELETE SET NULL,
  type            TEXT NOT NULL DEFAULT 'other'
                  CHECK (type IN ('association','fair','chamber','registry','cluster','directory','customs','marketplace','map','editorial','other')),
  name            TEXT NOT NULL,
  url             TEXT,
  member_list_url TEXT,
  discovery_round INTEGER NOT NULL DEFAULT 1,
  harvest_status  TEXT NOT NULL DEFAULT 'pending' CHECK (harvest_status IN ('pending','harvested','unreachable')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_channels_tenant ON research_channels(tenant_id);
CREATE INDEX idx_research_channels_project ON research_channels(project_id);

-- ------------------------------------------
-- CHUNKS (D1) — the work unit: one ICP × geography cell, with coverage/saturation.
-- ------------------------------------------
CREATE TABLE research_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  icp_id        UUID REFERENCES research_icps(id) ON DELETE CASCADE,
  geo_id        UUID REFERENCES research_geographies(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','paused','done')),
  found_count   INTEGER NOT NULL DEFAULT 0,
  estimate      INTEGER,
  -- Per-angle coverage matrix + the two saturation flags (00 §3).
  coverage      JSONB NOT NULL DEFAULT '{}',
  saturation    JSONB NOT NULL DEFAULT '{}',
  fully_covered BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_chunks_tenant ON research_chunks(tenant_id);
CREATE INDEX idx_research_chunks_project ON research_chunks(project_id);

-- ==========================================
-- RLS + updated_at triggers — standard tenant-scoped self-serve set.
-- Identical semantics to 055's explicit policies; applied in a loop here.
-- ==========================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'research_hs_codes','research_markets','research_icps',
    'research_geographies','research_channels','research_chunks'
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
