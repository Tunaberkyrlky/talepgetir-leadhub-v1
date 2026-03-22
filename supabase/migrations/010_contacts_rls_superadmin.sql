-- ==========================================
-- Fix contacts RLS: add superadmin override
-- Matches the pattern used by companies table
-- ==========================================

-- Drop existing policies
DROP POLICY IF EXISTS "contacts_select" ON contacts;
DROP POLICY IF EXISTS "contacts_insert" ON contacts;
DROP POLICY IF EXISTS "contacts_update" ON contacts;
DROP POLICY IF EXISTS "contacts_delete" ON contacts;

-- Recreate with is_superadmin() fallback
CREATE POLICY "contacts_select" ON contacts
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    OR is_superadmin()
  );

CREATE POLICY "contacts_insert" ON contacts
  FOR INSERT WITH CHECK (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin', 'ops_agent'))
    OR is_superadmin()
  );

CREATE POLICY "contacts_update" ON contacts
  FOR UPDATE USING (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin', 'ops_agent'))
    OR is_superadmin()
  );

CREATE POLICY "contacts_delete" ON contacts
  FOR DELETE USING (
    (tenant_id = get_user_tenant_id() AND get_user_role() = 'superadmin')
    OR is_superadmin()
  );
