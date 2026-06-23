-- ==========================================
-- Prefix-based campaign → tenant assignment
-- ------------------------------------------
-- A PlusVibe campaign is assigned to a tenant by matching the leading part of its
-- name against a configured prefix (e.g. "NTR" → Naturagen, "KR" → Koç Reduktör).
-- This replaces per-campaign manual assignment: assignment is now fully derived
-- from these rules. One prefix maps to exactly one tenant (case-insensitive
-- UNIQUE); a tenant may have many prefixes (NT, NTR, …).
-- ==========================================

CREATE TABLE IF NOT EXISTS campaign_prefix_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prefix      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Case-insensitive uniqueness: a prefix belongs to one tenant only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_prefix_rules_prefix
  ON campaign_prefix_rules (upper(prefix));
CREATE INDEX IF NOT EXISTS idx_campaign_prefix_rules_tenant
  ON campaign_prefix_rules (tenant_id);

ALTER TABLE campaign_prefix_rules ENABLE ROW LEVEL SECURITY;

-- Only internal roles manage prefix rules (same posture as plusvibe_campaigns).
CREATE POLICY "prefix_rules_select" ON campaign_prefix_rules
  FOR SELECT USING (is_superadmin() OR get_user_role() = 'ops_agent');
CREATE POLICY "prefix_rules_insert" ON campaign_prefix_rules
  FOR INSERT WITH CHECK (is_superadmin() OR get_user_role() = 'ops_agent');
CREATE POLICY "prefix_rules_delete" ON campaign_prefix_rules
  FOR DELETE USING (is_superadmin() OR get_user_role() = 'ops_agent');

-- ── Bootstrap from existing assignments ──
-- Derive a clean prefix (leading alphanumeric run, uppercased) from every currently
-- assigned campaign, so nothing breaks when assignment flips to prefix-driven.
-- Verified conflict-free at design time; ON CONFLICT keeps one row should any prefix
-- ever map to two tenants (review the table afterward if so).
WITH derived AS (
  SELECT tenant_id,
         substring(upper(btrim(name)) FROM '^[A-Z0-9]+') AS prefix
  FROM plusvibe_campaigns
  WHERE tenant_id IS NOT NULL
    AND substring(upper(btrim(name)) FROM '^[A-Z0-9]+') ~ '.'
)
INSERT INTO campaign_prefix_rules (tenant_id, prefix)
SELECT DISTINCT ON (prefix) tenant_id, prefix
FROM derived
ORDER BY prefix, tenant_id
ON CONFLICT (upper(prefix)) DO NOTHING;
