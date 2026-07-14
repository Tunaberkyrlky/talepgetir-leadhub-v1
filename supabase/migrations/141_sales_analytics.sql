-- Tibexa Core CRM Expansion — sales analytics + forecast RPC  [141]
-- The dashboard's Sales section needs one tenant-scoped snapshot of the commercial
-- pipeline: win/loss (with standardized loss reasons), lead-source conversion,
-- average sales cycle, open-pipeline value, a probability-weighted forecast, an
-- expected-close calendar, an open-deal-by-stage funnel, and a deal-data-quality
-- ratio. Computing these client-side would be many round-trips; this RPC folds
-- them into ONE call (CTEs scan `deals` a few times — no N+1 on the dashboard).
--
-- SECURITY DEFINER + explicit p_tenant_id (135 posture): the server always passes
-- the auth-resolved tenant (never user input), so the definer-rights read stays
-- tenant-scoped. Locked to service_role (135/119 posture): only the API's admin
-- client may call it; authenticated JWTs cannot pass an arbitrary tenant.
--
-- FINANCIAL SCOPE: this reads customer-entered deal `amount` (their own pipeline
-- value) only — never any COGS/margin field. So a tenant-scoped exposure (like
-- /ops) is correct; no cross-tenant cost data can leak.
--
-- MULTI-CURRENCY: deals.currency is NOT NULL (3-letter). Pipeline value, forecast
-- and the close calendar are therefore GROUPED BY currency — never summed across
-- currencies (that would be meaningless). The UI renders one row per currency.
--
-- WINDOW SEMANTICS: p_days (30/90/365 from the client, clamped here) bounds the
-- decided-deal block — win/loss counts, loss-reason distribution, average cycle
-- (deals whose closed_at falls in the window). Pipeline value, weighted forecast,
-- data quality, the stage funnel and the close calendar are a LIVE snapshot of
-- currently-open deals (window-independent). Lead-source conversion is all-time
-- (a stable rate). The UI subtitle states this split.
--
-- STAGE→STAGE CONVERSION NOTE: a true transition-based conversion rate needs a
-- structured deal-stage-transition log, which does NOT exist yet — the only stage
-- history is company-level `status_change` activities carrying free-text Turkish
-- summaries ("Aşama değişikliği: X → Y") with no machine-readable old/new slug, so
-- parsing them would be brittle. We therefore expose `stage_funnel` = the current
-- distribution of OPEN deals across pipeline stages (ordered by sort_order); the UI
-- presents it as the pipeline-by-stage funnel and derives step conversion visually.

-- ── DEPENDENCY: migration 139_qualification (E4 slice) ──────────────────────
-- This RPC reads deals.lead_source and deals.loss_reason_code — both columns are
-- added by 139 (the E4 qualification slice, integrated BEFORE this one). 139 < 141
-- in the repo series and in the staging apply order, so the columns are guaranteed
-- present when this runs. The guard below is defensive: a wrong-order apply raises
-- a clear, actionable error here instead of a confusing "column does not exist"
-- failure deep inside get_sales_metrics.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'deals' AND column_name = 'lead_source'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'deals' AND column_name = 'loss_reason_code'
  ) THEN
    RAISE EXCEPTION '141 requires 139_qualification (deals.lead_source/loss_reason_code)';
  END IF;
END $$;

-- ── pipeline_stages.win_probability (SHARED table — additive only) ──────────
-- Admin-set per-stage win probability (0-100) that drives the weighted forecast.
-- ADD COLUMN IF NOT EXISTS with NO DEFAULT so existing rows are untouched and no
-- table rewrite occurs; the CHECK is added by-name via a pg_constraint probe
-- (139/133 posture) so a re-apply never errors and a shared staging table's own
-- objects/policies are never clobbered. NULL means "unset" — the RPC falls back to
-- a documented heuristic below.
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS win_probability INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.pipeline_stages'::regclass
       AND conname = 'pipeline_stages_win_probability_check'
  ) THEN
    ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_win_probability_check
      CHECK (win_probability IS NULL OR (win_probability BETWEEN 0 AND 100));
  END IF;
END $$;

-- ── get_sales_metrics ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_sales_metrics(
  p_tenant_id UUID,
  p_days      INT
)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    -- Bound p_days defensively (the server clamps too). Window bounds the decided-deal block.
    SELECT (now() - make_interval(days => GREATEST(1, LEAST(365, p_days)))) AS window_start
  ),
  -- Per-stage forecast probability. FALLBACK HEURISTIC (documented): when a stage's
  -- win_probability is unset, pipeline-type stages get a simple LINEAR ramp by
  -- sort_order — the r-th of n pipeline stages gets round(100 * r / (n+1))%, so the
  -- first stage is lowest and the last stays below 100 (nothing open is "certain").
  -- Non-pipeline stages fall back to a flat default (initial = low, terminal = 50);
  -- open deals rarely sit in those, so the default is a harmless guard.
  pl AS (
    SELECT slug,
           win_probability,
           row_number() OVER (ORDER BY sort_order, slug) AS rnk,
           count(*)     OVER ()                          AS n
      FROM pipeline_stages
     WHERE tenant_id = p_tenant_id AND is_active = true AND stage_type = 'pipeline'
  ),
  stage_prob AS (
    SELECT slug,
           COALESCE(win_probability, round(100.0 * rnk / (n + 1))::int) AS prob
      FROM pl
    UNION ALL
    SELECT slug,
           COALESCE(win_probability, CASE WHEN stage_type = 'initial' THEN 5 ELSE 50 END) AS prob
      FROM pipeline_stages
     WHERE tenant_id = p_tenant_id AND is_active = true AND stage_type <> 'pipeline'
  ),
  -- Currently-open deals with a resolved forecast probability (unknown stage → 50).
  -- FORECAST BASE = open deals sitting in a PIPELINE-type stage only. A deal can be
  -- status='open' while parked in a terminal/initial stage; those must not inflate
  -- the forecast, data-quality ratio, open_deal_count or the close calendar. The
  -- INNER JOIN to pipeline_stages (tenant-qualified, is_active, stage_type='pipeline'
  -- — same predicate as 135's pstages CTE) enforces that.
  open_deals AS (
    SELECT d.amount, d.currency, d.stage, d.expected_close, d.lead_source,
           COALESCE(sp.prob, 50) AS prob
      FROM deals d
      JOIN pipeline_stages ps
        ON ps.tenant_id = d.tenant_id AND ps.slug = d.stage
       AND ps.is_active = true AND ps.stage_type = 'pipeline'
      LEFT JOIN stage_prob sp ON sp.slug = d.stage
     WHERE d.tenant_id = p_tenant_id AND d.status = 'open'
  ),
  -- Pipeline value + weighted forecast, per currency (amount-bearing open deals).
  pipe AS (
    SELECT currency,
           round(SUM(amount)::numeric, 2)                  AS pipeline_value,
           round(SUM(amount * prob / 100.0)::numeric, 2)   AS weighted_forecast,
           count(*)                                        AS deal_count
      FROM open_deals
     WHERE amount IS NOT NULL
     GROUP BY currency
  ),
  -- Deal-data-quality: share of ALL open deals that carry BOTH amount AND expected_close.
  dq AS (
    SELECT count(*)                                                                     AS open_total,
           count(*) FILTER (WHERE amount IS NOT NULL AND expected_close IS NOT NULL)     AS complete
      FROM open_deals
  ),
  -- Deals decided within the window (won/lost by closed_at). cycle_days = created→closed.
  closed AS (
    SELECT status, loss_reason_code,
           extract(epoch FROM (closed_at - created_at)) / 86400.0 AS cycle_days
      FROM deals
     WHERE tenant_id = p_tenant_id
       AND status IN ('won', 'lost')
       AND closed_at IS NOT NULL
       AND closed_at >= (SELECT window_start FROM params)
  ),
  wl AS (
    SELECT count(*) FILTER (WHERE status = 'won')                                        AS win_count,
           count(*) FILTER (WHERE status = 'lost')                                       AS loss_count,
           round((avg(cycle_days) FILTER (WHERE status = 'won'))::numeric, 1)            AS avg_cycle_days
      FROM closed
  ),
  -- Standardized loss-reason distribution (139 taxonomy). Legacy NULL → 'unspecified'.
  loss_reasons AS (
    SELECT COALESCE(loss_reason_code, 'unspecified') AS code, count(*) AS cnt
      FROM closed
     WHERE status = 'lost'
     GROUP BY COALESCE(loss_reason_code, 'unspecified')
  ),
  -- Lead-source conversion (all-time, deal-based). Blank/NULL source → 'unknown'.
  src AS (
    SELECT COALESCE(NULLIF(btrim(lead_source), ''), 'unknown')  AS source,
           count(*)                                             AS total,
           count(*) FILTER (WHERE status = 'won')               AS won,
           count(*) FILTER (WHERE status = 'lost')              AS lost,
           count(*) FILTER (WHERE status = 'open')              AS open_count
      FROM deals
     WHERE tenant_id = p_tenant_id
     GROUP BY COALESCE(NULLIF(btrim(lead_source), ''), 'unknown')
     ORDER BY count(*) DESC
     LIMIT 20
  ),
  -- Open-deal distribution across pipeline stages (the stage funnel). Only stages
  -- that actually hold open deals, ordered by sort_order.
  funnel AS (
    SELECT ps.slug AS stage, ps.sort_order, count(d.id) AS cnt
      FROM pipeline_stages ps
      LEFT JOIN deals d
        ON d.tenant_id = ps.tenant_id AND d.stage = ps.slug AND d.status = 'open'
     WHERE ps.tenant_id = p_tenant_id AND ps.is_active = true AND ps.stage_type = 'pipeline'
     GROUP BY ps.slug, ps.sort_order
    HAVING count(d.id) > 0
  ),
  -- Expected-close calendar: open deals with an expected_close, by month + currency.
  cal AS (
    SELECT to_char(date_trunc('month', expected_close), 'YYYY-MM') AS month,
           currency,
           round(COALESCE(SUM(amount), 0)::numeric, 2)             AS amount,
           count(*)                                                AS cnt
      FROM open_deals
     WHERE expected_close IS NOT NULL
     GROUP BY 1, currency
     ORDER BY 1, currency
     LIMIT 36
  )
  SELECT jsonb_build_object(
    'days',              GREATEST(1, LEAST(365, p_days)),
    'quality_threshold', 50,
    'win_count',         (SELECT win_count  FROM wl),
    'loss_count',        (SELECT loss_count FROM wl),
    'win_rate',          (SELECT CASE WHEN (win_count + loss_count) > 0
                                       THEN round(100.0 * win_count / (win_count + loss_count))::int
                                       ELSE NULL END FROM wl),
    'avg_cycle_days',    (SELECT avg_cycle_days FROM wl),
    'open_deal_count',   (SELECT open_total FROM dq),
    'data_quality',      (SELECT CASE WHEN open_total > 0
                                      THEN round(100.0 * complete / open_total)::int
                                      ELSE NULL END FROM dq),
    -- Forecast is only trustworthy when enough open deals carry amount + close date.
    'forecast_ready',    (SELECT CASE WHEN open_total > 0
                                        AND (100.0 * complete / NULLIF(open_total, 0)) >= 50
                                      THEN true ELSE false END FROM dq),
    'pipeline', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'currency', currency,
                            'pipeline_value', pipeline_value,
                            'weighted_forecast', weighted_forecast,
                            'deal_count', deal_count) ORDER BY currency)
                            FROM pipe), '[]'::jsonb),
    'loss_reasons', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'code', code, 'count', cnt) ORDER BY cnt DESC)
                            FROM loss_reasons), '[]'::jsonb),
    'source_conversion', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'source', source,
                            'total', total, 'won', won, 'lost', lost, 'open', open_count,
                            'win_rate', CASE WHEN (won + lost) > 0
                                             THEN round(100.0 * won / (won + lost))::int
                                             ELSE NULL END) ORDER BY total DESC)
                            FROM src), '[]'::jsonb),
    'stage_funnel', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'stage', stage, 'count', cnt) ORDER BY sort_order)
                            FROM funnel), '[]'::jsonb),
    'close_calendar', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'month', month, 'currency', currency,
                            'amount', amount, 'count', cnt) ORDER BY month, currency)
                            FROM cal), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION get_sales_metrics(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_sales_metrics(UUID, INT) TO service_role;
