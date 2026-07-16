-- 149_research_reset_derived_data.sql
--
-- Central subject-change invalidation for the research wizard.
--
-- Every wizard artifact after the profile is AI-derived from the project's subject: ICPs from the
-- profile, geographies + offers from the approved ICP, verdicts/chunks/channels from the ICP×geo
-- cell, HS codes from the products/profile, market evidence from the HS codes + seller country.
-- Each auto-generation step only fires when its artifact table is empty, and none of them were
-- invalidated when the subject changed — so a reused / re-researched project (or one whose profile
-- fields were edited) kept showing the PREVIOUS subject's ICPs, geos, offers, HS codes, and lead
-- verdicts, and could even hand stale leads to CRM.
--
-- This function clears all of that project-scoped derived data in ONE transaction so every step
-- re-generates on the new subject. It is called by routes/research/projects.ts's PATCH handler
-- whenever the project's subject fingerprint (the whole subject-defining profile) actually changes.
--
-- Cascade map (verified against the live schema):
--   DELETE research_icps  ->  cascades research_geographies, research_offers,
--                             research_company_verdicts, research_chunks (all icp_id ON DELETE
--                             CASCADE). research_channels is icp_id/geo_id ON DELETE SET NULL, so it
--                             is deleted EXPLICITLY here.
--   research_markets + research_hs_codes are product/profile-derived (not ICP children) and are
--   cleared whenever p_clear_hs is true. Deleting HS sets research_markets.hs_code_id to NULL
--   (SET NULL), so markets are deleted first.
--   In-flight jobs: any queued/running job for this project is working on the OLD subject and would
--   re-populate the tables we just cleared, so they are all canceled here. (A worker already mid
--   -insert is a narrow single-user race that the next step's empty-table auto-run self-heals.)
--
-- NOT cleared, deliberately:
--   * research_companies — the permanent tenant-wide dedup / suppression / CRM-export ledger. Its
--     per-ICP verdicts cascade away with the ICPs (a re-harvest re-scores under the fresh ICPs),
--     while suppression + already-exported-to-CRM state must survive across subjects.
--   * research_messages — AI outreach drafts (per company×ICP). Not wizard-visible; may hold
--     already-sent-message records, so they are left intact (their icp_id goes NULL when the ICP is
--     deleted) rather than risk destroying an outreach record on a research subject change.
--
-- SECURITY DEFINER + service_role-only, same convention as the other research RPCs.

CREATE OR REPLACE FUNCTION research_reset_derived_data(
    p_tenant   UUID,
    p_project  UUID,
    p_clear_hs BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_jobs     INTEGER := 0;
    v_channels INTEGER := 0;
    v_icps     INTEGER := 0;
    v_markets  INTEGER := 0;
    v_hs       INTEGER := 0;
BEGIN
    -- Cancel any in-flight (queued/running) DERIVED-DATA generation job for this project first: they
    -- were generated for the OLD subject and would otherwise re-insert just-cleared rows. Restricted
    -- to an allow-list of the jobs that repopulate the tables cleared below — NOT every job type:
    -- notably trade:ingest (a customs-CSV import whose side-car batch would be stranded by a cancel)
    -- and profile:crawl (the wizard re-runs it itself) are excluded, as are unrelated outreach/
    -- feedback/enrichment jobs. New generation jobs are enqueued by the wizard AFTER this reset.
    UPDATE research_jobs
       SET status = 'canceled'
     WHERE tenant_id = p_tenant AND project_id = p_project
       AND status IN ('queued', 'running')
       AND type IN (
           'icp:generate', 'icp:revise', 'hs:match', 'geo:analyze', 'offer:generate', 'market:analyze',
           'harvest:run', 'maps:harvest', 'channels:harvest', 'channels:discover', 'research:orchestrate', 'trade:harvest'
       );
    GET DIAGNOSTICS v_jobs = ROW_COUNT;

    -- channels: icp_id/geo_id are SET NULL, so they do NOT cascade with the ICP delete below.
    DELETE FROM research_channels WHERE tenant_id = p_tenant AND project_id = p_project;
    GET DIAGNOSTICS v_channels = ROW_COUNT;

    -- ICPs: cascades geographies, offers, company_verdicts, chunks.
    DELETE FROM research_icps WHERE tenant_id = p_tenant AND project_id = p_project;
    GET DIAGNOSTICS v_icps = ROW_COUNT;

    IF p_clear_hs THEN
        -- markets first (hs_code_id FK is SET NULL, would otherwise orphan them), then HS codes.
        DELETE FROM research_markets WHERE tenant_id = p_tenant AND project_id = p_project;
        GET DIAGNOSTICS v_markets = ROW_COUNT;
        DELETE FROM research_hs_codes WHERE tenant_id = p_tenant AND project_id = p_project;
        GET DIAGNOSTICS v_hs = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'jobs_canceled',    v_jobs,
        'channels_deleted', v_channels,
        'icps_deleted',     v_icps,
        'markets_deleted',  v_markets,
        'hs_deleted',       v_hs
    );
END;
$$;

REVOKE ALL ON FUNCTION research_reset_derived_data(UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_reset_derived_data(UUID, UUID, BOOLEAN) TO service_role;
