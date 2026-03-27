-- ============================================================
-- Enforce at most one is_primary contact per company.
-- Step 1: clean up any existing duplicates (keep the oldest).
-- Step 2: add a partial unique index so the DB rejects future violations.
-- ============================================================

-- Remove duplicate primaries — keep the one with the earliest created_at
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at ASC) AS rn
    FROM contacts
    WHERE is_primary = true
)
UPDATE contacts
SET is_primary = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Partial unique index: only one row per company_id may have is_primary = true
CREATE UNIQUE INDEX IF NOT EXISTS contacts_one_primary_per_company
    ON contacts (company_id)
    WHERE is_primary = true;
