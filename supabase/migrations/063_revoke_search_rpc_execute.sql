-- Revoke direct execution of tenant-scoped SECURITY DEFINER RPCs from public roles.
--
-- These functions run as SECURITY DEFINER (bypass RLS) and filter only on the
-- caller-supplied p_tenant_id. With EXECUTE granted to anon/authenticated, any
-- signed-in (or anon-key) caller could pass another tenant's id and read that
-- tenant's companies/contacts directly via /rest/v1/rpc — a cross-tenant IDOR.
--
-- The server now calls search_companies / search_contacts exclusively via
-- supabaseAdmin (service_role), passing the caller's own tenant (client roles
-- cannot switch tenants — the auth middleware 403s an X-Tenant-Id override).
-- service_role is unaffected by these REVOKEs, so the app keeps working.
--
-- save_campaign_graph is a SECURITY DEFINER write already called only via
-- supabaseAdmin; no client path exists, so revoking is safe.
--
-- Mirrors the pattern established in 020_revoke_public_rpc_execute.sql.
--
-- NOTE: signature-independent (loops over every overload). The prod and test
-- projects have diverged (prod search_companies = 11 args, test = 13 args; and
-- save_campaign_graph is absent on test), so a hard-coded signature would fail
-- on one project. This form is idempotent and skips any function that is absent.

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('search_companies', 'search_contacts', 'save_campaign_graph')
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', fn);
    END LOOP;
END $$;
