-- RPC to count activities grouped by type (avoids fetching all rows to JS)
CREATE OR REPLACE FUNCTION get_activity_type_counts(
    p_tenant_id UUID,
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL,
    p_type TEXT DEFAULT NULL,
    p_visibility TEXT DEFAULT NULL,
    p_created_by UUID DEFAULT NULL,
    p_search TEXT DEFAULT NULL
)
RETURNS TABLE(type TEXT, count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
    SELECT a.type::TEXT, COUNT(*) AS count
    FROM activities a
    WHERE a.tenant_id = p_tenant_id
      AND (p_date_from IS NULL OR a.occurred_at >= p_date_from)
      AND (p_date_to IS NULL OR a.occurred_at <= p_date_to)
      AND (p_type IS NULL OR a.type = p_type)
      AND (p_visibility IS NULL OR a.visibility = p_visibility)
      AND (p_created_by IS NULL OR a.created_by = p_created_by)
      AND (p_search IS NULL OR a.summary ILIKE '%' || p_search || '%' OR a.detail ILIKE '%' || p_search || '%')
    GROUP BY a.type;
$$;

-- Index for activity date-filtered queries
CREATE INDEX IF NOT EXISTS idx_activities_tenant_occurred
    ON activities(tenant_id, occurred_at);
