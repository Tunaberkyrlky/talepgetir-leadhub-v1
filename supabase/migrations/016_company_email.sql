-- ==========================================
-- 016: Add company email + email verification status
-- ==========================================
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_status TEXT CHECK (email_status IN ('valid', 'uncertain', 'invalid'));

-- Recreate view to pick up new columns (SELECT * is expanded at view creation time)
DROP VIEW IF EXISTS companies_with_counts;
CREATE VIEW companies_with_counts AS
SELECT
    c.*,
    COALESCE(cc.contact_count, 0)::int AS contact_count
FROM companies c
LEFT JOIN (
    SELECT company_id, COUNT(*)::int AS contact_count
    FROM contacts
    GROUP BY company_id
) cc ON cc.company_id = c.id;
