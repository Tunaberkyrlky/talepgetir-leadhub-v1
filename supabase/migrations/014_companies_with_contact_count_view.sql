-- ==========================================
-- 014: Create view for companies with contact_count
-- ==========================================
-- Enables server-side sorting by contact_count via Supabase .order()

CREATE OR REPLACE VIEW companies_with_counts AS
SELECT
    c.*,
    COALESCE(cc.contact_count, 0)::int AS contact_count
FROM companies c
LEFT JOIN (
    SELECT company_id, COUNT(*)::int AS contact_count
    FROM contacts
    GROUP BY company_id
) cc ON cc.company_id = c.id;
