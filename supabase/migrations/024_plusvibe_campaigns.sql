-- ==========================================
-- PlusVibe Campaigns — synced from PlusVibe API
-- tenant_id is NULLABLE: NULL = unassigned, set by admin when assigning to a client
-- ==========================================

CREATE TABLE plusvibe_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  pv_campaign_id  TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  status          TEXT,
  total_leads     INTEGER DEFAULT 0,
  emails_sent     INTEGER DEFAULT 0,
  opens           INTEGER DEFAULT 0,
  clicks          INTEGER DEFAULT 0,
  replies         INTEGER DEFAULT 0,
  bounces         INTEGER DEFAULT 0,
  open_rate       REAL DEFAULT 0,
  click_rate      REAL DEFAULT 0,
  reply_rate      REAL DEFAULT 0,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE plusvibe_campaigns ENABLE ROW LEVEL SECURITY;

-- ── Indexes ──

CREATE INDEX idx_pv_campaigns_tenant ON plusvibe_campaigns(tenant_id);
CREATE INDEX idx_pv_campaigns_pv_id ON plusvibe_campaigns(pv_campaign_id);

-- ── RLS Policies ──
-- Superadmin/ops_agent: see all campaigns (assigned + unassigned)
-- Client roles: see only campaigns assigned to their tenant

CREATE POLICY "pv_campaigns_select" ON plusvibe_campaigns
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    OR is_superadmin()
    OR get_user_role() = 'ops_agent'
  );

-- Only superadmin/ops_agent can insert/update/delete (sync + assign operations)
CREATE POLICY "pv_campaigns_insert" ON plusvibe_campaigns
  FOR INSERT WITH CHECK (
    is_superadmin() OR get_user_role() = 'ops_agent'
  );

CREATE POLICY "pv_campaigns_update" ON plusvibe_campaigns
  FOR UPDATE USING (
    is_superadmin() OR get_user_role() = 'ops_agent'
  );

CREATE POLICY "pv_campaigns_delete" ON plusvibe_campaigns
  FOR DELETE USING (
    is_superadmin() OR get_user_role() = 'ops_agent'
  );

-- ── Trigger ──

CREATE TRIGGER set_pv_campaigns_updated_at
  BEFORE UPDATE ON plusvibe_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
