-- ==========================================
-- TG-Research v2 — Foundation
-- Projects + job queue (Postgres-backed) + usage ledger/holds
-- Isolated module: all tables prefixed research_*, additive only.
-- Conventions mirror 001_foundation.sql / 002_companies.sql:
--   get_user_tenant_id(), get_user_role(), is_superadmin(), update_updated_at()
-- ==========================================

-- ==========================================
-- RESEARCH PROJECTS
-- One per research engagement. Holds the customer company profile (FAZ A),
-- lifecycle status, and the scale target the customer commits to (C3).
-- ==========================================

CREATE TABLE research_projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'setup'
                CHECK (status IN ('setup','icp','calibration','scaling','enrichment','handoff','paused','archived')),
  -- Company profile (website, what they do, products, target markets, exclusions).
  -- AI pre-fills from the website; the customer edits. (FAZ A1)
  profile       JSONB NOT NULL DEFAULT '{}',
  -- How many MATCH companies to scale to (C3). NULL until calibration is done.
  scale_target  INTEGER,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE research_projects ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_research_projects_tenant ON research_projects(tenant_id);
CREATE INDEX idx_research_projects_tenant_status ON research_projects(tenant_id, status);

-- ==========================================
-- RESEARCH JOBS — the work queue (K3)
-- Long-running work (search, validation, harvest, enrichment) never runs in the
-- request/response cycle. The API enqueues a row here; the worker service claims
-- it via research_claim_job() (SKIP LOCKED), runs it, writes progress + result.
-- ==========================================

CREATE TABLE research_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES research_projects(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  priority      INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  -- Progress is whatever the handler reports (e.g. {found: 12, estimate: 480}).
  progress      JSONB NOT NULL DEFAULT '{}',
  result        JSONB,
  error         TEXT,
  -- When the job becomes eligible to claim (drives delayed jobs + retry backoff).
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lock bookkeeping for the claiming worker.
  locked_by     TEXT,
  locked_at     TIMESTAMPTZ,
  heartbeat_at  TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE research_jobs ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_research_jobs_tenant ON research_jobs(tenant_id);
CREATE INDEX idx_research_jobs_project ON research_jobs(project_id);
-- Claim hot-path: only queued rows, ordered by priority then schedule.
CREATE INDEX idx_research_jobs_claim ON research_jobs(priority DESC, scheduled_at ASC, created_at ASC)
  WHERE status = 'queued';
-- Reaper hot-path: only running rows, by heartbeat age.
CREATE INDEX idx_research_jobs_running ON research_jobs(heartbeat_at)
  WHERE status = 'running';

-- ==========================================
-- RESEARCH USAGE LEDGER — append-only credit/lead accounting (01_KREDI §5)
-- Single source of truth for lead-quota balance. Positive delta = grant,
-- negative = consumed MATCH lead. balance_after caches the running total.
-- ==========================================

CREATE TABLE research_usage_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  ref_type      TEXT,
  ref_id        UUID,
  balance_after INTEGER NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE research_usage_ledger ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_research_usage_ledger_tenant ON research_usage_ledger(tenant_id, created_at DESC);

-- ==========================================
-- RESEARCH USAGE HOLDS — reserve/settle/release for a run (D3/D4)
-- Reserve estimated leads when a run starts; settle the realized count when it
-- finishes; release the remainder. Prevents mid-run double-charge / negative balance.
-- ==========================================

CREATE TABLE research_usage_holds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id        UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  reserved      INTEGER NOT NULL DEFAULT 0,
  settled       INTEGER NOT NULL DEFAULT 0,
  released      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','released')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE research_usage_holds ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_research_usage_holds_tenant ON research_usage_holds(tenant_id);
CREATE INDEX idx_research_usage_holds_job ON research_usage_holds(job_id);

-- ==========================================
-- QUEUE RPCs (SECURITY DEFINER — called by the worker via service role)
-- ==========================================

-- Atomically claim the next eligible job. Uses FOR UPDATE SKIP LOCKED so many
-- worker instances can poll concurrently without grabbing the same row.
-- p_types: restrict to these job types (NULL = any type).
CREATE OR REPLACE FUNCTION research_claim_job(
  p_worker_id TEXT,
  p_types     TEXT[] DEFAULT NULL
)
RETURNS SETOF research_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job research_jobs;
BEGIN
  SELECT * INTO v_job
  FROM research_jobs
  WHERE status = 'queued'
    AND scheduled_at <= now()
    AND (p_types IS NULL OR type = ANY(p_types))
  ORDER BY priority DESC, scheduled_at ASC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE research_jobs
  SET status       = 'running',
      attempts     = attempts + 1,
      locked_by    = p_worker_id,
      locked_at    = now(),
      heartbeat_at = now(),
      started_at   = COALESCE(started_at, now()),
      updated_at   = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN NEXT v_job;
END;
$$;

-- Requeue (or fail, if out of attempts) jobs whose worker died mid-run — detected
-- by a stale heartbeat. Run periodically by the worker's reaper tick. Returns the
-- number of jobs reaped.
CREATE OR REPLACE FUNCTION research_reap_stale_jobs(
  p_timeout INTERVAL DEFAULT '5 minutes'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH reaped AS (
    UPDATE research_jobs
    SET status       = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        error        = CASE WHEN attempts >= max_attempts
                            THEN COALESCE(error, 'Worker timed out (stale lock reaped)')
                            ELSE error END,
        locked_by    = NULL,
        locked_at    = NULL,
        -- Exponential backoff before the next attempt.
        scheduled_at = CASE WHEN attempts >= max_attempts
                            THEN scheduled_at
                            ELSE now() + (INTERVAL '10 seconds' * power(2, attempts)) END,
        finished_at  = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
        updated_at   = now()
    WHERE status = 'running'
      AND heartbeat_at < now() - p_timeout
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM reaped;
  RETURN v_count;
END;
$$;

-- The worker authenticates with the service_role key; grant it execute explicitly.
GRANT EXECUTE ON FUNCTION research_claim_job(TEXT, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION research_reap_stale_jobs(INTERVAL) TO service_role;

-- ==========================================
-- RLS POLICIES
-- Defense-in-depth only: the API + worker use the service_role key (bypasses RLS)
-- and scope every query by tenant_id manually. These policies matter if a
-- user-scoped client (createUserClient) ever touches these tables. Research is
-- self-serve, so client_admin can write within its own tenant.
-- ==========================================

-- research_projects
CREATE POLICY "research_projects_select" ON research_projects
  FOR SELECT USING (tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "research_projects_insert" ON research_projects
  FOR INSERT WITH CHECK (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
    OR is_superadmin()
  );
CREATE POLICY "research_projects_update" ON research_projects
  FOR UPDATE USING (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
    OR is_superadmin()
  );
CREATE POLICY "research_projects_delete" ON research_projects
  FOR DELETE USING (
    (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','client_admin'))
    OR is_superadmin()
  );

-- research_jobs — SELECT only for tenant users. The queue is a state machine
-- managed exclusively by the API + worker (service_role); user-scoped PostgREST
-- access must NOT INSERT/UPDATE jobs (would let clients forge status/result or
-- bypass enqueue validation + quota). Enqueue + cancel go through /api/research.
CREATE POLICY "research_jobs_select" ON research_jobs
  FOR SELECT USING (tenant_id = get_user_tenant_id() OR is_superadmin());

-- research_usage_ledger — read-only for tenant; writes go through service role only.
CREATE POLICY "research_usage_ledger_select" ON research_usage_ledger
  FOR SELECT USING (tenant_id = get_user_tenant_id() OR is_superadmin());

-- research_usage_holds — read-only for tenant; writes go through service role only.
CREATE POLICY "research_usage_holds_select" ON research_usage_holds
  FOR SELECT USING (tenant_id = get_user_tenant_id() OR is_superadmin());

-- ==========================================
-- TRIGGERS (updated_at)
-- ==========================================

CREATE TRIGGER research_projects_updated_at
  BEFORE UPDATE ON research_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER research_jobs_updated_at
  BEFORE UPDATE ON research_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER research_usage_holds_updated_at
  BEFORE UPDATE ON research_usage_holds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
