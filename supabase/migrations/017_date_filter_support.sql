-- Update get_stage_counts RPC to accept optional date params
CREATE OR REPLACE FUNCTION get_stage_counts(
    p_tenant_id UUID,
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(stage TEXT, count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
    SELECT c.stage::TEXT, COUNT(*) AS count
    FROM companies c
    WHERE c.tenant_id = p_tenant_id
      AND (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
    GROUP BY c.stage;
$$;

-- Composite index for date-filtered queries
CREATE INDEX IF NOT EXISTS idx_companies_tenant_created
    ON companies(tenant_id, created_at);
