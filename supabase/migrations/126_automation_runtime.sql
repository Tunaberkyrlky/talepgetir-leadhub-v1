-- Tibexa CRM Expansion v3 — WP5 Automation runtime schema  [126]
-- The state machine behind the event-driven automation runtime (v3 §6.6, §10.1,
-- §10.3 versioning, §10.4 retry/idempotency). Sits ON TOP of the best-effort event
-- backbone (125_automation_events_outbox): a queued domain event is claimed, matched
-- against active automations, and drives a per-lead/company RUN through an immutable
-- graph of nodes, recording every side-effect intent in an idempotent action ledger.
--
-- Four tables:
--   • automations          — the definition head (trigger/entry/stop/goal + current_version)
--   • automation_versions  — immutable published graph snapshots (nodes+edges); a run pins one
--   • automation_runs      — one execution per subject; cursor (current_node_key) + wait/goal/stop
--   • automation_actions   — idempotent side-effect ledger; UNIQUE(run_id,node_key,idempotency_key)
--
-- GUARDRAIL: this migration adds SCHEMA ONLY. The runtime worker entry
-- (lib/automation/runtime.ts#runtimeTick) is FLAG-GATED (AUTOMATION_WORKER_ENABLED)
-- and is NOT wired into any live loop, so nothing steps a run, nothing sends
-- (email/WhatsApp/SMS/call), and no CRM row is mutated by automation at rest.
-- Send-capable node types exist only as skipped STUBs in code (C3 wires email).
-- Versioning: a run pins automation_versions.version at claim; publishing a new
-- version bumps automations.current_version but NEVER rewrites a running run's graph.
--
-- FILE-ONLY: do NOT apply from this worktree. On the shared staging DB the
-- orchestrator MUST first confirm none of these names already exist (parallel-worktree
-- collision):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN
--        ('automations','automation_versions','automation_runs','automation_actions');
-- If any collide, an adapter is needed instead of this file.
--
-- RLS/trigger posture copied verbatim from 123/124/125: tenant_id FK CASCADE, ENABLE
-- RLS, 4 policies (select = tenant OR superadmin; writes gate get_user_role() IN
-- superadmin/ops_agent/client_admin), SECURITY DEFINER tenant-consistency fence.
-- The runtime writes via supabaseAdmin (service role, bypasses RLS) with an explicit
-- tenant_id, so the DB-level fences below are the real backstop. Purely additive.

-- ── automations ──────────────────────────────────────────────────────────────
-- The definition head. trigger_event / goal_event are event_type strings from
-- lib/automation/events.ts (TEXT, no FK to a catalog table). entry_criteria and
-- stop_conditions are opaque predicate JSON evaluated by the runtime (C2 condition
-- node + global stop check). current_version points at the active published graph in
-- automation_versions; a draft with no published version has current_version NULL.
CREATE TABLE automations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,                    -- tenant-unique stable slug
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_event   TEXT NOT NULL,                    -- domain event that starts a run
  entry_criteria  JSONB NOT NULL DEFAULT '{}',      -- predicate; empty ⇒ always match
  stop_conditions JSONB NOT NULL DEFAULT '[]',      -- predicates that stop a running run
  goal_event      TEXT,                             -- event that marks a run goal-reached
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','archived')),
  current_version INTEGER,                          -- active published version (NULL ⇒ draft only)
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A key is stable + unique per tenant (the automation's external handle).
CREATE UNIQUE INDEX uq_automations_tenant_key ON automations (tenant_id, key);
-- Claim scan (C2): the runtime lists ACTIVE automations whose trigger matches an event.
CREATE INDEX idx_automations_trigger
  ON automations (tenant_id, trigger_event) WHERE status = 'active';

-- ── automation_versions ──────────────────────────────────────────────────────
-- An IMMUTABLE published graph snapshot. graph = { entry: node_key, nodes: { key →
-- { type, config, next?, branches? } } } (nodes + edges frozen). A run pins one
-- (automation_id, version); editing an automation publishes a NEW version row and
-- bumps automations.current_version — it never rewrites this snapshot. tenant_id is
-- denormalized for RLS; the fence keeps it consistent with the parent automation.
CREATE TABLE automation_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  graph         JSONB NOT NULL,                     -- immutable { entry, nodes:{…} }
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_automation_versions_ver
  ON automation_versions (automation_id, version);

-- Immutability: once written, a version's graph is frozen (only the runtime reads it,
-- and running runs pin it). Reject any UPDATE that would change the snapshot identity.
CREATE OR REPLACE FUNCTION automation_versions_guard_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.graph::text        IS DISTINCT FROM OLD.graph::text
     OR NEW.version         IS DISTINCT FROM OLD.version
     OR NEW.automation_id   IS DISTINCT FROM OLD.automation_id
     OR NEW.tenant_id       IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'automation_versions % is immutable (graph/version/automation_id/tenant_id)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_versions_immutable ON automation_versions;
CREATE TRIGGER automation_versions_immutable
  BEFORE UPDATE ON automation_versions
  FOR EACH ROW EXECUTE FUNCTION automation_versions_guard_immutable();

-- ── automation_runs ──────────────────────────────────────────────────────────
-- One execution of an automation for one subject (a lead or a company). version pins
-- the graph the run walks (§10.3). current_node_key is the cursor; status drives the
-- lifecycle; wake_at is when a WAITING run becomes eligible again (wait node). The
-- runtime steps this row; a live tick is flag-gated OFF this round.
CREATE TABLE automation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id   UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,                 -- pinned automation_versions.version
  lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
  company_id      UUID REFERENCES companies(id) ON DELETE SET NULL,
  trigger_event_id UUID REFERENCES automation_events_outbox(id) ON DELETE SET NULL,
  current_node_key TEXT,                            -- cursor; NULL once terminal
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','waiting','paused','completed','stopped','failed')),
  wake_at         TIMESTAMPTZ,                      -- set by wait node; when to resume
  goal_reached    BOOLEAN NOT NULL DEFAULT false,
  stop_reason     TEXT,
  context         JSONB NOT NULL DEFAULT '{}',      -- accumulated run context (C4 fills)
  -- Run-level lease (§10.4 concurrency): stepRun claims the run before processing so at
  -- most ONE stepper advances a run at a time. A stale lease (crashed stepper) is
  -- reclaimable after 5 minutes. NULL locked_at ⇒ free. See runtime.ts#stepRun.
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Version pin FK (§10.3): the pinned (automation_id, version) MUST reference a real
  -- immutable snapshot, and that snapshot cannot be deleted while a run still pins it
  -- (ON DELETE RESTRICT) — a published graph never vanishes under a running run.
  CONSTRAINT fk_automation_runs_version
    FOREIGN KEY (automation_id, version)
    REFERENCES automation_versions (automation_id, version) ON DELETE RESTRICT
);

-- Wake scan (C2 tick): only WAITING runs whose wake_at has arrived are candidates.
CREATE INDEX idx_automation_runs_wake
  ON automation_runs (wake_at) WHERE status = 'waiting';
-- Runnable scan: RUNNING runs to step immediately.
CREATE INDEX idx_automation_runs_runnable
  ON automation_runs (tenant_id, status) WHERE status IN ('running','waiting');
-- Subject lookups + one-run-per-subject de-dup support.
CREATE INDEX idx_automation_runs_lead
  ON automation_runs (tenant_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_automation_runs_company
  ON automation_runs (tenant_id, company_id) WHERE company_id IS NOT NULL;
-- In-flight de-dup (race backstop): at most ONE non-terminal run per (tenant, automation,
-- subject). claimAndStart also checks in app code, but two concurrent events for the same
-- subject would both pass that check and insert; this partial UNIQUE forces the second
-- INSERT to collide (23505, swallowed as benign) so a subject is never double-enrolled.
CREATE UNIQUE INDEX uq_automation_runs_inflight_lead
  ON automation_runs (tenant_id, automation_id, lead_id)
  WHERE lead_id IS NOT NULL AND status IN ('running','waiting','paused');
CREATE UNIQUE INDEX uq_automation_runs_inflight_company
  ON automation_runs (tenant_id, automation_id, company_id)
  WHERE company_id IS NOT NULL AND status IN ('running','waiting','paused');

-- ── automation_actions ───────────────────────────────────────────────────────
-- The idempotent side-effect LEDGER. Every node execution that could touch the world
-- (a send, a CRM mutation, a wait scheduling) writes exactly one row keyed by
-- (run_id, node_key, idempotency_key). A re-step of the same node computes the SAME
-- idempotency_key and collides on the UNIQUE below (23505, swallowed) → the action is
-- NEVER performed twice (§10.4). provider_request_id captures the external side's id
-- so a provider timeout (unknown outcome) can be reconciled instead of blind-retried.
CREATE TABLE automation_actions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id              UUID NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  node_key            TEXT NOT NULL,
  node_type           TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 1,
  idempotency_key     TEXT NOT NULL,                -- stable per intended action
  input_snapshot      JSONB NOT NULL DEFAULT '{}',
  provider_request_id TEXT,                         -- external id (send nodes; NULL here)
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','succeeded','failed','skipped')),
  output              JSONB NOT NULL DEFAULT '{}',
  event_ref           UUID REFERENCES automation_events_outbox(id) ON DELETE SET NULL, -- outbox event this action emitted (if any)
  retry_reason        TEXT,
  scheduled_at        TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IDEMPOTENCY: one action per (run, node, key). A repeat step of the same node hits
-- this and returns 23505 (swallowed as benign) — the side-effect is done at-most-once.
CREATE UNIQUE INDEX uq_automation_actions_idem
  ON automation_actions (run_id, node_key, idempotency_key);
-- Ledger scan for a run (inspector / re-step short-circuit), newest first.
CREATE INDEX idx_automation_actions_run
  ON automation_actions (tenant_id, run_id, created_at DESC);

-- ── tenant-consistency fences (125 assert_tenant_consistency pattern) ─────────
-- Service-role code sets tenant_id + FK columns directly. Each fence verifies the
-- parent rows this row references live in the SAME tenant, so a cross-tenant pointer
-- can never be persisted even though the writer bypasses RLS. tenant_id is always
-- NOT NULL. Defense in depth atop app-layer tenant scoping.

-- automation_versions: automation must be same-tenant.
CREATE OR REPLACE FUNCTION automation_versions_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.automations
                  WHERE id = NEW.automation_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'automation_versions: automation % is not in tenant %', NEW.automation_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS automation_versions_tenant_consistency ON automation_versions;
CREATE TRIGGER automation_versions_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, automation_id ON automation_versions
  FOR EACH ROW EXECUTE FUNCTION automation_versions_assert_tenant();

-- automation_runs: automation + lead + company must all be same-tenant when present.
CREATE OR REPLACE FUNCTION automation_runs_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.automations
                  WHERE id = NEW.automation_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'automation_runs: automation % is not in tenant %', NEW.automation_id, NEW.tenant_id;
  END IF;
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'automation_runs: lead % is not in tenant %', NEW.lead_id, NEW.tenant_id;
  END IF;
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.companies WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'automation_runs: company % is not in tenant %', NEW.company_id, NEW.tenant_id;
  END IF;
  IF NEW.trigger_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.automation_events_outbox
       WHERE id = NEW.trigger_event_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'automation_runs: trigger_event % is not in tenant %', NEW.trigger_event_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS automation_runs_tenant_consistency ON automation_runs;
CREATE TRIGGER automation_runs_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, automation_id, lead_id, company_id, trigger_event_id ON automation_runs
  FOR EACH ROW EXECUTE FUNCTION automation_runs_assert_tenant();

-- automation_actions: run must be same-tenant.
CREATE OR REPLACE FUNCTION automation_actions_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.automation_runs
                  WHERE id = NEW.run_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'automation_actions: run % is not in tenant %', NEW.run_id, NEW.tenant_id;
  END IF;
  IF NEW.event_ref IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.automation_events_outbox
       WHERE id = NEW.event_ref AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'automation_actions: event_ref % is not in tenant %', NEW.event_ref, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS automation_actions_tenant_consistency ON automation_actions;
CREATE TRIGGER automation_actions_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, run_id, event_ref ON automation_actions
  FOR EACH ROW EXECUTE FUNCTION automation_actions_assert_tenant();

-- ── updated_at touch triggers (shared update_updated_at from earlier migrations) ─
CREATE TRIGGER automations_updated_at
  BEFORE UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER automation_runs_updated_at
  BEFORE UPDATE ON automation_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── claim RPC (SECURITY DEFINER — runtime service role, C2) ───────────────────
-- Atomically claim the oldest QUEUED outbox events (FOR UPDATE SKIP LOCKED so many
-- runtime instances can drain concurrently), stamp status='claimed'/claimed_at, and
-- return them. This is the real body behind outbox.ts#claimBatch, but it is consumed
-- ONLY by the flag-gated runtimeTick — with AUTOMATION_WORKER_ENABLED unset nothing
-- calls it, so no night claim/step/send happens.
CREATE OR REPLACE FUNCTION automation_events_claim(p_limit INTEGER DEFAULT 20)
RETURNS SETOF automation_events_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM automation_events_outbox
     WHERE status = 'queued'
     ORDER BY occurred_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(p_limit, 0)
  )
  UPDATE automation_events_outbox e
     SET status     = 'claimed',
         claimed_at = now(),
         attempts   = e.attempts + 1
    FROM picked
   WHERE e.id = picked.id
  RETURNING e.*;
END;
$$;

-- ── RLS (verbatim 123/124/125 posture) ───────────────────────────────────────
ALTER TABLE automations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_actions  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "automations_select" ON automations FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "automations_insert" ON automations FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automations_update" ON automations FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automations_delete" ON automations FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

CREATE POLICY "automation_versions_select" ON automation_versions FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "automation_versions_insert" ON automation_versions FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automation_versions_update" ON automation_versions FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
-- NO delete policy (immutable published graph, §10.3): a published version is never
-- removed via the tenant API. With RLS enabled and no DELETE policy, every tenant-role
-- DELETE is denied. The runs→versions FK (ON DELETE RESTRICT) additionally blocks
-- deleting a version a live run still pins even from service-role paths.

CREATE POLICY "automation_runs_select" ON automation_runs FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "automation_runs_insert" ON automation_runs FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automation_runs_update" ON automation_runs FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automation_runs_delete" ON automation_runs FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

CREATE POLICY "automation_actions_select" ON automation_actions FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "automation_actions_insert" ON automation_actions FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automation_actions_update" ON automation_actions FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automation_actions_delete" ON automation_actions FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

COMMENT ON TABLE automations IS
  'v3 WP5 automation definition head: trigger/entry/stop/goal + current_version. A published graph lives in automation_versions; runs execute in automation_runs. Runtime worker is flag-gated (AUTOMATION_WORKER_ENABLED) and unwired — no live tick/send. Additive.';
COMMENT ON TABLE automation_versions IS
  'v3 WP5 immutable published graph snapshot (nodes+edges). A run pins (automation_id, version); publishing bumps automations.current_version but never rewrites a running run''s graph (§10.3).';
COMMENT ON TABLE automation_runs IS
  'v3 WP5 one automation execution per subject (lead/company). version pins the graph; current_node_key is the cursor; status running/waiting/paused/completed/stopped/failed; wake_at resumes waits. Stepped only by the flag-gated runtime.';
COMMENT ON TABLE automation_actions IS
  'v3 WP5 idempotent side-effect ledger. UNIQUE(run_id,node_key,idempotency_key) makes every action at-most-once (§10.4) — a re-step of the same node collides (23505) and never re-performs the side-effect. Send-capable nodes are skipped stubs this round.';
