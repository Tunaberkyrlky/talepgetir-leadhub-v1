-- ==========================================
-- TG-Research v2 — lock the job queue to service-role writes only.
--
-- research_jobs is a state machine driven exclusively by the API + worker
-- (service_role). The original INSERT/UPDATE policies let any tenant writer-role
-- mutate the queue via user-scoped PostgREST (PATCH /rest/v1/research_jobs):
-- forging status='succeeded'/result, tampering with locked_by/attempts, or
-- inserting jobs that skip enqueue validation + (future) quota checks.
-- Drop them. Clients keep SELECT (to watch job status); enqueue + cancel go
-- through /api/research/jobs, which uses the service-role key.
-- (Flagged by codex review of the skeleton.)
-- Idempotent so fresh installs — where 055 no longer creates these — are a no-op.
-- ==========================================

DROP POLICY IF EXISTS "research_jobs_insert" ON research_jobs;
DROP POLICY IF EXISTS "research_jobs_update" ON research_jobs;
