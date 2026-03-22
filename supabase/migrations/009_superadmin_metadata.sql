-- ==========================================
-- Move superadmin check from memberships to app_metadata
-- Superadmin is now tenant-independent
-- ==========================================

CREATE OR REPLACE FUNCTION is_superadmin()
RETURNS BOOLEAN AS $$
  SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'is_superadmin')::BOOLEAN, false);
$$ LANGUAGE sql STABLE SECURITY DEFINER;
