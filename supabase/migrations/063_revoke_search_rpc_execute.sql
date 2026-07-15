-- Revoke direct execution of tenant-scoped SECURITY DEFINER RPCs from public roles.
--
-- These functions run as SECURITY DEFINER (bypass RLS) and filter only on the
-- caller-supplied p_tenant_id. With EXECUTE reachable by anon/authenticated, any
-- signed-in (or anon-key) caller could pass another tenant's id and read that
-- tenant's companies/contacts directly via /rest/v1/rpc — a cross-tenant IDOR.
--
-- The server now calls search_companies / search_contacts exclusively via
-- supabaseAdmin (service_role), passing the caller's own tenant (client roles
-- cannot switch tenants — the auth middleware 403s an X-Tenant-Id override).
-- save_campaign_graph is a SECURITY DEFINER write already called only via
-- supabaseAdmin; no client path exists.
--
-- We REVOKE from PUBLIC as well as anon/authenticated: search_* had explicit
-- anon/authenticated grants, but save_campaign_graph was reachable via the
-- default PUBLIC EXECUTE grant (acl `=X/...`), which a FROM anon,authenticated
-- revoke does not remove. We then re-GRANT to service_role so the server keeps
-- working regardless of how the PUBLIC grant was structured.
--
-- Signature-independent (loops over every overload) so it is safe across the
-- prod/test signature divergence (prod search_companies = 11 args, test = 13)
-- and idempotent (skips any function that is absent, e.g. save_campaign_graph
-- does not exist on the test project). Mirrors 020_revoke_public_rpc_execute.sql.

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
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END $$;
