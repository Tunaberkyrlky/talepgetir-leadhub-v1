-- ==========================================
-- RPC Functions
-- ==========================================

-- RPC: Count companies by stage for a given tenant
CREATE OR REPLACE FUNCTION get_stage_counts(p_tenant_id UUID)
RETURNS TABLE(stage TEXT, count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
    SELECT c.stage::TEXT, COUNT(*) AS count
    FROM companies c
    WHERE c.tenant_id = p_tenant_id
    GROUP BY c.stage;
$$;
