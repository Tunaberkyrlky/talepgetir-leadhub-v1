-- Ledger-aligned version: applied to TG-Research test as 20260716181845.
--
-- admin_audit_log is written only by trusted server code through the service-role
-- client. Keep the table private from PostgREST client roles and append-only for
-- service_role so audit history cannot be changed or removed by application code.

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.admin_audit_log TO service_role;

DROP POLICY IF EXISTS admin_audit_log_service_select ON public.admin_audit_log;
CREATE POLICY admin_audit_log_service_select
    ON public.admin_audit_log
    FOR SELECT
    TO service_role
    USING (true);

DROP POLICY IF EXISTS admin_audit_log_service_insert ON public.admin_audit_log;
CREATE POLICY admin_audit_log_service_insert
    ON public.admin_audit_log
    FOR INSERT
    TO service_role
    WITH CHECK (true);
