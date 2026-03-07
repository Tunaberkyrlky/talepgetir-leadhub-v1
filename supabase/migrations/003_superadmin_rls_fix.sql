-- ==========================================
-- Superadmin RLS Fix
-- ==========================================

-- Helper function to check if user is superadmin in ANY tenant
CREATE OR REPLACE FUNCTION is_superadmin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships
    WHERE user_id = auth.uid()
      AND role = 'superadmin'
      AND is_active = true
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Update tenants_select policy
DROP POLICY IF EXISTS "tenants_select" ON tenants;
CREATE POLICY "tenants_select" ON tenants
  FOR SELECT USING (
    id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID
    OR is_superadmin()
  );

-- Update memberships_select policy
DROP POLICY IF EXISTS "memberships_select" ON memberships;
CREATE POLICY "memberships_select" ON memberships
  FOR SELECT USING (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID
    OR is_superadmin()
  );

-- Update companies policies (to allow superadmin access to any tenant)
DROP POLICY IF EXISTS "companies_select" ON companies;
CREATE POLICY "companies_select" ON companies
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    OR is_superadmin()
  );

DROP POLICY IF EXISTS "companies_insert" ON companies;
CREATE POLICY "companies_insert" ON companies
  FOR INSERT WITH CHECK (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin', 'ops_agent'))
    OR is_superadmin()
  );

DROP POLICY IF EXISTS "companies_update" ON companies;
CREATE POLICY "companies_update" ON companies
  FOR UPDATE USING (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin', 'ops_agent'))
    OR is_superadmin()
  );

DROP POLICY IF EXISTS "companies_delete" ON companies;
CREATE POLICY "companies_delete" ON companies
  FOR DELETE USING (
    (tenant_id = get_user_tenant_id() AND get_user_role() = 'superadmin')
    OR is_superadmin()
  );
