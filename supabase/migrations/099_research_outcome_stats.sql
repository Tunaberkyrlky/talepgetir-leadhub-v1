-- ==========================================
-- TG-Research v2 — WP5: campaign outcome feedback aggregate  [099]
--
-- Closes the "doğru offer" loop with MEASUREMENT: feedback:aggregate (worker, daily +
-- admin run-now) reads TG-Core campaign outcomes for research-EXPORTED companies
-- (crm_company_id set) and writes per-(ICP × geo × angle) aggregates here. K8 one-way
-- boundary holds: research READS the CRM (email_replies / campaign_enrollments — defensive,
-- a missing table degrades to zeros) and writes ONLY to this research-owned table.
-- CRM opt-out signals (enrollment unsubscribed / reply not_interested) sync into
-- research_suppression via the existing fenced research_suppress_company RPC ('opt_out').
--
-- COUNTS ONLY — no dollar columns, safe for every role to read. The aggregator is a full
-- per-tenant recompute (idempotent upsert on the unique cell), so re-running is a no-op.
-- ==========================================

CREATE TABLE IF NOT EXISTS research_outcome_stats (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  icp_id     UUID REFERENCES research_icps(id) ON DELETE CASCADE,
  geo_id     UUID REFERENCES research_geographies(id) ON DELETE CASCADE,
  angle_code TEXT,                        -- NULL = all angles rollup
  period     TEXT NOT NULL DEFAULT 'all', -- v1: cumulative; monthly buckets can join later
  exported   INTEGER NOT NULL DEFAULT 0,
  sent       INTEGER NOT NULL DEFAULT 0,
  replies    INTEGER NOT NULL DEFAULT 0,
  positive   INTEGER NOT NULL DEFAULT 0,
  optouts    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per stat cell; NULLS NOT DISTINCT so the (geo NULL, angle NULL) rollup rows are
-- unique too (PG15+; this DB is PG17).
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_outcome_stats_cell
  ON research_outcome_stats(tenant_id, icp_id, geo_id, angle_code, period) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_research_outcome_stats_icp
  ON research_outcome_stats(tenant_id, icp_id);

-- Users read their own tenant's counts; writes are worker-only (service role).
ALTER TABLE research_outcome_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_outcome_stats_select ON research_outcome_stats FOR SELECT
  USING (tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE TRIGGER research_outcome_stats_updated_at BEFORE UPDATE ON research_outcome_stats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
