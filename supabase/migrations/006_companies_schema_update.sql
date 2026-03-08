-- ==========================================
-- Companies Schema Update
-- - Rename employee_count → employee_size
-- - Add product_services, description, linkedin, company_phone
-- ==========================================

ALTER TABLE companies RENAME COLUMN employee_count TO employee_size;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS product_services TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS linkedin TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_phone TEXT;
