-- 117_research_market_analyze_unique_inflight.sql
-- WP11 follow-up (P1): the POST /research/hs/market-analyze route only had an advisory
-- check-then-enqueue guard (findInflightMarketAnalysis) with a race window between the
-- check and the insert. Two concurrent requests could both pass the check and each
-- enqueue their own market:analyze job, which then race each other's non-transactional
-- delete-then-insert on research_markets and can leave duplicate world_import/bilateral_export
-- evidence rows. Scoped to type = 'market:analyze' only (not a blanket per-type index) so
-- every other job type's legitimate same-project concurrency (e.g. geo:analyze per cell) is
-- untouched. The route now catches the resulting unique-violation and returns the winning
-- job instead of a raw 500.
CREATE UNIQUE INDEX idx_research_jobs_market_analyze_one_inflight
  ON research_jobs (tenant_id, project_id)
  WHERE type = 'market:analyze' AND status IN ('queued', 'running');
