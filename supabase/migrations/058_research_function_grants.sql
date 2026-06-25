-- ==========================================
-- TG-Research v2 — lock down the queue RPCs to the worker (service_role) only.
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, which exposes these
-- SECURITY DEFINER functions to the anon/authenticated roles via PostgREST
-- (/rest/v1/rpc/...). research_claim_job / research_reap_stale_jobs mutate the
-- job queue and must never be callable except by the worker. Revoke the implicit
-- PUBLIC grant and keep only the explicit service_role grant.
-- (Flagged by the Supabase security advisor: anon_security_definer_function_executable.)
-- ==========================================

REVOKE ALL ON FUNCTION research_claim_job(TEXT, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION research_claim_job(TEXT, TEXT[]) FROM anon;
REVOKE ALL ON FUNCTION research_claim_job(TEXT, TEXT[]) FROM authenticated;

REVOKE ALL ON FUNCTION research_reap_stale_jobs(INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION research_reap_stale_jobs(INTERVAL) FROM anon;
REVOKE ALL ON FUNCTION research_reap_stale_jobs(INTERVAL) FROM authenticated;

GRANT EXECUTE ON FUNCTION research_claim_job(TEXT, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION research_reap_stale_jobs(INTERVAL) TO service_role;
