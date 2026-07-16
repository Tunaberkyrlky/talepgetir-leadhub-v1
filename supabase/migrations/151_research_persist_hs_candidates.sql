-- 151_research_persist_hs_candidates.sql
--
-- Atomic, job-fenced persistence for hs:match candidates — brings hs:match up to the same
-- subject-change safety the ICP/geo persist RPCs already have.
--
-- hs:match runs an LLM call + live UN Comtrade validation (seconds), then replaces the project's
-- undecided AI HS candidates. If the project's SUBJECT changes during that window, projects.ts's
-- PATCH calls research_reset_derived_data (migration 149), which cancels this job
-- (research_jobs.status) and clears the HS table. Without a fence, the handler could then re-insert
-- candidates for the OLD subject AFTER they were cleared, leaving stale rows that suppress the
-- step-22 auto-rematch (the very bug this whole change closes).
--
-- This function serializes against that reset on the JOB ROW: it locks the job FOR UPDATE and
-- refuses (returns -1) if the job is no longer 'running'. Because research_reset_derived_data's own
-- UPDATE of research_jobs takes the same row lock, exactly one of {reset, persist} wins — either
-- persistence commits first and the reset then deletes what it wrote, or the reset commits first
-- and persistence sees 'canceled' and refuses. Either way no stale HS rows survive.
--
-- The fence is keyed on (job, tenant, status='running', locked_by, lease) — the SAME attempt-fence
-- research_persist_icp_drafts uses — so a REAPED stale attempt (whose lease was reassigned to a
-- newer attempt) also writes nothing, not only a subject-change-canceled one.
--
-- Returns the number of candidate rows inserted (>= 0), or -1 when this attempt no longer owns the
-- running job (canceled by a subject-change reset, or lease lost to a reaper) — the caller throws
-- so the runner does not record a successful zero-result.
-- SECURITY DEFINER + service_role-only, same convention as the other research RPCs.

CREATE OR REPLACE FUNCTION research_persist_hs_candidates(
    p_tenant     UUID,
    p_project    UUID,
    p_job        UUID,
    p_locked_by  TEXT,
    p_lease      UUID,
    p_candidates JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_status   TEXT;
    v_inserted INTEGER := 0;
BEGIN
    -- Fence: only the attempt that currently holds the lease on the still-running job may persist.
    SELECT status INTO v_status
      FROM research_jobs
     WHERE id = p_job AND tenant_id = p_tenant
       AND locked_by = p_locked_by AND lease IS NOT DISTINCT FROM p_lease
       FOR UPDATE;
    IF v_status IS DISTINCT FROM 'running' THEN
        RETURN -1;
    END IF;

    -- Replace only the undecided AI candidate set (approved/rejected human decisions are immutable).
    DELETE FROM research_hs_codes
     WHERE tenant_id = p_tenant AND project_id = p_project AND source = 'ai' AND status = 'candidate';

    -- Insert survivors the human hasn't already decided on (any source), so the same code can never
    -- get a fresh candidate row alongside a decided one.
    INSERT INTO research_hs_codes (tenant_id, project_id, code, description, status, source)
    SELECT p_tenant, p_project, c.code, c.description, 'candidate', 'ai'
      FROM jsonb_to_recordset(p_candidates) AS c(code TEXT, description TEXT)
     WHERE NOT EXISTS (
         SELECT 1 FROM research_hs_codes d
          WHERE d.tenant_id = p_tenant AND d.project_id = p_project
            AND d.code = c.code AND d.status IN ('approved', 'rejected')
     );
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION research_persist_hs_candidates(UUID, UUID, UUID, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_persist_hs_candidates(UUID, UUID, UUID, TEXT, UUID, JSONB) TO service_role;
