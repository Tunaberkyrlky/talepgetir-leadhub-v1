-- Restrict tenant-scoped SECURITY DEFINER search RPCs to the server.
--
-- Each function accepts a caller-supplied p_tenant_id and bypasses RLS. Direct
-- PostgREST EXECUTE access would therefore allow a client to bypass the HTTP
-- middleware's tenant checks. The API routes call these functions only through
-- supabaseAdmin after resolving the authenticated user's tenant.
--
-- Signature-independent and idempotent: every overload is covered, while
-- functions not yet present in an older environment are simply skipped.

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN (
              'search_companies',
              'search_contacts',
              'search_companies_archive',
              'search_contacts_archive'
          )
    LOOP
        EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
            fn
        );
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END $$;
