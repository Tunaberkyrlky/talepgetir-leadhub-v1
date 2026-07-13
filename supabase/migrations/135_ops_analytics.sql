-- Tibexa Core CRM Expansion — operations analytics RPC  [135]
-- The dashboard's Operations section needs a single tenant-scoped snapshot of how
-- the team is actually working: open/overdue tasks, recent completion rate, active
-- companies with no owner or no recent contact, per-owner workload and per-stage
-- dwell time. Computing these client-side would be many round-trips; this RPC folds
-- them into ONE call (CTEs scan tasks/companies once each — no N+1 on the dashboard).
--
-- SECURITY DEFINER + explicit p_tenant_id: the server always passes the auth-resolved
-- tenant (never user input), so the definer-rights read stays tenant-scoped. Locked to
-- service_role (119/115 posture): only the API's admin client may call it; authenticated
-- JWTs cannot pass an arbitrary tenant.
--
-- Shared-tasks note (120 adapter): the `tasks` table is shared with the cold-email
-- worktree, whose rows use status 'open'. Our CRM semantics are 'pending' (active) and
-- 'completed'. Every task predicate here filters to OUR statuses only, so cold-email
-- rows never inflate these counts.
--
-- Human-contact activity types MUST stay identical to get_pipeline_signals [119] and
-- HUMAN_CONTACT_ACTIVITY_TYPES in companies.ts.

CREATE OR REPLACE FUNCTION get_ops_metrics(
  p_tenant_id UUID,
  p_days      INT
)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH win AS (
    -- Bound p_days defensively; 14d stale-contact threshold is fixed (independent of the window).
    SELECT (now() - make_interval(days => GREATEST(1, LEAST(365, p_days)))) AS window_start,
           (now() - interval '14 days')                                     AS stale_cutoff
  ),
  -- "Active" companies = the tenant's pipeline-type stages (excludes initial 'cold' and
  -- terminal won/lost/on_hold), resolved per-tenant so custom stage configs are honoured.
  pstages AS (
    SELECT slug, sort_order
      FROM pipeline_stages
     WHERE tenant_id = p_tenant_id
       AND stage_type = 'pipeline'
       AND is_active = true
  ),
  -- Single scan of OUR task rows (pending/completed only — never cold-email 'open'/'cancelled').
  task_agg AS (
    SELECT
      count(*) FILTER (WHERE status = 'pending')                                    AS open_tasks,
      count(*) FILTER (WHERE status = 'pending' AND due_at < now())                 AS overdue_tasks,
      count(*) FILTER (WHERE status = 'completed'
                         AND completed_at >= (SELECT window_start FROM win))        AS completed_tasks,
      -- Completion rate = of tasks that came DUE within the window, the share now completed.
      count(*) FILTER (WHERE due_at >= (SELECT window_start FROM win)
                         AND due_at <= now())                                       AS due_in_window,
      count(*) FILTER (WHERE status = 'completed'
                         AND due_at >= (SELECT window_start FROM win)
                         AND due_at <= now())                                       AS completed_in_window
    FROM tasks
    WHERE tenant_id = p_tenant_id
      AND status IN ('pending', 'completed')
  ),
  -- Per-owner open workload (pending only). owner_id may be NULL (unassigned pending task).
  owner_agg AS (
    SELECT assigned_to                                       AS owner_id,
           count(*)                                          AS open_ct,
           count(*) FILTER (WHERE due_at < now())            AS overdue_ct
      FROM tasks
     WHERE tenant_id = p_tenant_id
       AND status = 'pending'
     GROUP BY assigned_to
     ORDER BY count(*) DESC
     LIMIT 30
  ),
  -- Active companies + their last human-contact timestamp (LEFT JOIN + grouped max: no
  -- per-company round-trip). since = when the row entered its current stage (COALESCE to
  -- created_at because stage_changed_at is nullable for never-moved rows).
  active_co AS (
    SELECT c.id,
           c.stage,
           c.assigned_to,
           COALESCE(c.stage_changed_at, c.created_at)                                    AS since,
           max(a.occurred_at) FILTER (
             WHERE a.type IN ('not', 'meeting', 'follow_up', 'call', 'campaign_email'))   AS last_contact
      FROM companies c
      LEFT JOIN activities a
        ON a.tenant_id = c.tenant_id AND a.company_id = c.id
     WHERE c.tenant_id = p_tenant_id
       AND c.stage IN (SELECT slug FROM pstages)
     GROUP BY c.id, c.stage, c.assigned_to, c.stage_changed_at, c.created_at
  ),
  co_agg AS (
    SELECT
      count(*) FILTER (WHERE assigned_to IS NULL)                                        AS unowned_active,
      count(*) FILTER (WHERE last_contact IS NULL
                         OR last_contact < (SELECT stale_cutoff FROM win))               AS stale_contact
    FROM active_co
  ),
  -- Per-stage dwell: how long active rows have sat in their current stage (days).
  dwell AS (
    SELECT ac.stage,
           count(*)                                                                       AS cnt,
           round(avg(extract(epoch FROM (now() - ac.since)) / 86400.0)::numeric, 1)       AS avg_days,
           round((percentile_cont(0.5) WITHIN GROUP (
             ORDER BY extract(epoch FROM (now() - ac.since)) / 86400.0))::numeric, 1)      AS median_days,
           min(ps.sort_order)                                                             AS sort_order
      FROM active_co ac
      JOIN pstages ps ON ps.slug = ac.stage
     GROUP BY ac.stage
  )
  SELECT jsonb_build_object(
    'days',                GREATEST(1, LEAST(365, p_days)),
    'stale_days',          14,
    'open_tasks',          (SELECT open_tasks          FROM task_agg),
    'overdue_tasks',       (SELECT overdue_tasks       FROM task_agg),
    'completed_tasks',     (SELECT completed_tasks     FROM task_agg),
    'due_in_window',       (SELECT due_in_window       FROM task_agg),
    'completed_in_window', (SELECT completed_in_window FROM task_agg),
    'completion_rate',     (SELECT CASE WHEN due_in_window > 0
                                        THEN round(100.0 * completed_in_window / due_in_window)::int
                                        ELSE NULL END
                              FROM task_agg),
    'unowned_active',      (SELECT unowned_active      FROM co_agg),
    'stale_contact',       (SELECT stale_contact       FROM co_agg),
    'owner_load', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'owner_id', owner_id, 'open', open_ct, 'overdue', overdue_ct))
                              FROM owner_agg), '[]'::jsonb),
    'stage_dwell', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'stage', stage, 'count', cnt,
                              'avg_days', avg_days, 'median_days', median_days)
                              ORDER BY sort_order)
                              FROM dwell), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION get_ops_metrics(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_ops_metrics(UUID, INT) TO service_role;
