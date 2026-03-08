-- ==========================================
-- Contacts: full_name → first_name + last_name
-- Add: country, seniority, department
-- Drop: whatsapp_e164
-- ==========================================

-- 1. Add new columns
ALTER TABLE contacts
  ADD COLUMN first_name TEXT,
  ADD COLUMN last_name  TEXT,
  ADD COLUMN country    TEXT,
  ADD COLUMN seniority  TEXT,
  ADD COLUMN department TEXT;

-- 2. Migrate existing data: split full_name into first/last
UPDATE contacts
SET
  first_name = SPLIT_PART(full_name, ' ', 1),
  last_name  = NULLIF(TRIM(SUBSTRING(full_name FROM POSITION(' ' IN full_name) + 1)), '');

-- 3. Make first_name NOT NULL (after data is populated)
ALTER TABLE contacts
  ALTER COLUMN first_name SET NOT NULL;

-- 4. Drop old columns
ALTER TABLE contacts
  DROP COLUMN full_name,
  DROP COLUMN whatsapp_e164;
