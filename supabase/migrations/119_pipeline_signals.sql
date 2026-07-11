-- Tibexa Core CRM Expansion — pipeline work-signal RPC  [119]
-- The pipeline board enriches each card with its next pending task and its last
-- human contact. companies.ts computed both with chunked PostgREST queries capped
-- per chunk (LIMIT 5000 on activities) — a company whose latest contact sorts past
-- that cap silently loses its "last contact" hint. A window/aggregate function has
-- no per-group cap, so this is the correct fix; the route falls back to the chunked
-- path when this function isn't present yet (migration 119 pending).
--
-- SECURITY DEFINER + explicit p_tenant_id: the server always passes the
-- auth-resolved tenant (never user input), so the definer-rights read stays
-- tenant-scoped. Locked to service_role (115 posture): only the API's admin client
-- may call it; authenticated JWTs cannot pass an arbitrary tenant.

CREATE OR REPLACE FUNCTION get_pipeline_signals(
  p_tenant_id   UUID,
  p_company_ids UUID[]
)
RETURNS TABLE(
  company_id       UUID,
  next_task_id     UUID,
  next_task_title  TEXT,
  next_task_due_at TIMESTAMPTZ,
  last_contact_at  TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH ids AS (
    SELECT DISTINCT unnest(p_company_ids) AS cid
  ),
  -- Next pending task per company = smallest due_at (idx_tasks_company_due covers
  -- tenant_id, company_id, due_at WHERE status='pending'). id is the stable tie-break.
  next_task AS (
    SELECT DISTINCT ON (t.company_id)
           t.company_id AS cid, t.id AS task_id, t.title, t.due_at
      FROM tasks t
     WHERE t.tenant_id = p_tenant_id
       AND t.status = 'pending'
       AND t.company_id = ANY(p_company_ids)
     ORDER BY t.company_id, t.due_at ASC, t.id ASC
  ),
  -- Last contact = latest occurred_at across human-touch activity types only. This
  -- list MUST stay identical to HUMAN_CONTACT_ACTIVITY_TYPES in companies.ts.
  last_contact AS (
    SELECT a.company_id AS cid, max(a.occurred_at) AS last_contact_at
      FROM activities a
     WHERE a.tenant_id = p_tenant_id
       AND a.company_id = ANY(p_company_ids)
       AND a.type IN ('not', 'meeting', 'follow_up', 'call', 'campaign_email')
     GROUP BY a.company_id
  )
  SELECT i.cid,
         nt.task_id,
         nt.title,
         nt.due_at,
         lc.last_contact_at
    FROM ids i
    LEFT JOIN next_task    nt ON nt.cid = i.cid
    LEFT JOIN last_contact lc ON lc.cid = i.cid;
$$;

REVOKE ALL ON FUNCTION get_pipeline_signals(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_pipeline_signals(UUID, UUID[]) TO service_role;
