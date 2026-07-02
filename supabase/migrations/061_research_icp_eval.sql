-- ==========================================
-- TG-Research v2 — ICP Master (B5) eval columns
-- The strategy model generates ICP drafts; the customer then SCORES (/10) and EDITS
-- them (K7: AI proposes, human refines). To measure that gap (eval data), we freeze
-- the raw model output separately from the editable final.
--   • ai_draft            — the exact model-generated draft object (frozen, never edited)
--   • source              — 'ai' (generated) vs 'manual' (customer-authored from scratch)
--   • generated_by_job_id — the icp:generate job that produced it (provenance/COGS)
-- The existing research_icps columns (signals, …, human_score, note, status) hold the
-- EDITED FINAL. Additive only.
-- ==========================================

ALTER TABLE research_icps
  ADD COLUMN IF NOT EXISTS ai_draft JSONB NOT NULL DEFAULT '{}';

ALTER TABLE research_icps
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ai'
    CHECK (source IN ('ai','manual'));

ALTER TABLE research_icps
  ADD COLUMN IF NOT EXISTS generated_by_job_id UUID REFERENCES research_jobs(id) ON DELETE SET NULL;
