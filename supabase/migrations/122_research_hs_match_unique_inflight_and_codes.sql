-- 122_research_hs_match_unique_inflight_and_codes.sql
-- WP11 follow-up (P2): hs:match only had an advisory check-then-enqueue in-flight guard
-- (findInflightHsMatch in routes/research/hs.ts), unlike market:analyze which migration 117
-- backed with a DB-level partial unique index. A concurrent request race could enqueue two
-- hs:match jobs for the same project. Same fix shape as 117, scoped to type = 'hs:match' only
-- so every other job type's legitimate same-project concurrency is untouched. The route now
-- catches the resulting unique-violation (23505) and adopts the winning job.
CREATE UNIQUE INDEX idx_research_jobs_hs_match_one_inflight
  ON research_jobs (tenant_id, project_id)
  WHERE type = 'hs:match' AND status IN ('queued', 'running');

-- research_hs_codes had no uniqueness constraint at all: a duplicate model proposal (now
-- deduplicated application-side in hsMatch.ts) or any future concurrent-insert path could leave
-- two rows for the same code in the same project. A code is only ever meant to hold one row per
-- project (candidate, approved, or rejected — never more than one at a time; hsMatch.ts's own
-- decidedCodes check already enforces this invariant application-side on every re-run).
CREATE UNIQUE INDEX idx_research_hs_codes_project_code
  ON research_hs_codes (tenant_id, project_id, code);
