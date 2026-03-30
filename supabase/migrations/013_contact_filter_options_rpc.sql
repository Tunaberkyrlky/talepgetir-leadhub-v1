-- ============================================================
-- Efficient contact filter options via a single SQL function.
-- Replaces the O(n) approach of fetching all seniority/country
-- rows and deduplicating them in application code.
-- PostgreSQL can use partial indexes on these columns and returns
-- only the distinct set — no full row data is transferred.
-- ============================================================

CREATE OR REPLACE FUNCTION get_contact_filter_options(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
    SELECT jsonb_build_object(
        'seniorities', COALESCE(
            (
                SELECT jsonb_agg(s ORDER BY s)
                FROM (
                    SELECT DISTINCT seniority AS s
                    FROM contacts
                    WHERE tenant_id = p_tenant_id
                      AND seniority IS NOT NULL
                ) sub
            ),
            '[]'::jsonb
        ),
        'countries', COALESCE(
            (
                SELECT jsonb_agg(c ORDER BY c)
                FROM (
                    SELECT DISTINCT country AS c
                    FROM contacts
                    WHERE tenant_id = p_tenant_id
                      AND country IS NOT NULL
                ) sub
            ),
            '[]'::jsonb
        )
    );
$$;
