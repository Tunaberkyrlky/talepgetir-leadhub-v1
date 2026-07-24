-- 072_ops_overview_rpc.sql
-- Komuta Merkezi: tenant başına operasyon rollup'ı tek round-trip'te.
-- Service-role-only (063 ile aynı revoke posture); çağıran endpoint erişilebilir
-- tenant kümesini uygulama tarafında hesaplayıp p_tenant_ids ile geçirir.

CREATE OR REPLACE FUNCTION get_ops_tenant_overview(p_tenant_ids UUID[])
RETURNS TABLE (
  tenant_id UUID,
  companies BIGINT,
  contacts BIGINT,
  active_campaigns BIGINT,
  total_campaigns BIGINT,
  unread_inbound BIGINT,
  last_activity_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.id,
    (SELECT count(*) FROM companies c WHERE c.tenant_id = t.id),
    (SELECT count(*) FROM contacts ct WHERE ct.tenant_id = t.id),
    (SELECT count(*) FROM campaigns cp WHERE cp.tenant_id = t.id AND cp.status = 'active'),
    (SELECT count(*) FROM campaigns cp WHERE cp.tenant_id = t.id),
    (SELECT count(*) FROM email_replies er
       WHERE er.tenant_id = t.id AND er.direction = 'IN' AND er.read_status = 'unread'),
    (SELECT max(a.created_at) FROM activities a WHERE a.tenant_id = t.id)
  FROM tenants t
  WHERE t.id = ANY(p_tenant_ids);
$$;

REVOKE EXECUTE ON FUNCTION get_ops_tenant_overview(UUID[]) FROM PUBLIC, anon, authenticated;
