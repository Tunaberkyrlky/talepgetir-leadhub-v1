-- 105_research_flow_state.sql
-- WP6 (wizard-first rebuild): a single JSONB position marker for the Typeform-style
-- wizard shell — { step: number, completed_gates: string[] }. The coarse phase already
-- lives in research_projects.status (setup/icp/calibration/scaling/enrichment/handoff/
-- paused/archived) and is untouched; this column is purely the wizard's "where exactly
-- inside the current phase" pointer so a closed browser resumes at the same screen.
ALTER TABLE research_projects
  ADD COLUMN flow_state JSONB NOT NULL DEFAULT '{}'::jsonb;
