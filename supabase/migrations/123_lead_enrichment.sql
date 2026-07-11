-- Tibexa CRM Expansion v3 — WP2 Enrichment bridge  [123]
-- CRM-owned lead enrichment + qualification. A captured lead can be enriched
-- (website evidence, read-only) and scored against a qualification recipe; the
-- result is a lead_enrichment_runs row with a verdict (qualified/disqualified/
-- review). Low-confidence lands in `review` for a human (never auto-outbound).
-- (v3 plan §8 enrichment+qualification, §27/WP2, §26 code org lib/leads/qualification.ts)
--
-- GUARDRAIL: the research worker/queue schema (research_jobs …) is NOT touched —
-- enrichment runs live ONLY in this CRM-owned table. The adapter is read-only and
-- DRY-RUN by default (no live scrape). This migration is purely additive.
--
-- FILE-ONLY: do NOT apply from this worktree. 121_leads.sql is likewise file-only
-- on the shared staging DB. Before apply the orchestrator MUST confirm the name is
-- free (parallel-worktree tables, à la 120's adapter):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name = 'lead_enrichment_runs';
-- If it collides, an adapter is needed instead of this file.
--
-- RLS/trigger posture copied verbatim from 121_leads.sql: tenant_id FK CASCADE,
-- ENABLE RLS, 4 policies (select = tenant OR superadmin; writes gate
-- get_user_role() IN superadmin/ops_agent/client_admin), update_updated_at trigger,
-- SECURITY DEFINER BEFORE trigger asserting cross-table FKs stay in one tenant.

-- ── qualification recipe storage (MVP) ───────────────────────────────────────
-- The recipe (required fields + ICP/geo/company-size signals + thresholds) is an
-- OPTIONAL per-source JSONB config. NULL ⇒ qualification.ts applies its built-in
-- default recipe. Additive column on the existing lead_sources table.
ALTER TABLE lead_sources
  ADD COLUMN IF NOT EXISTS qualification_recipe JSONB;

COMMENT ON COLUMN lead_sources.qualification_recipe IS
  'v3 WP2 qualification recipe (required fields, ICP/geo/company-size signals, thresholds). NULL ⇒ built-in default recipe in lib/leads/qualification.ts.';

-- ── lead_enrichment_runs ─────────────────────────────────────────────────────
-- One enrichment+qualification attempt for a lead. Created queued by the enqueue
-- endpoint (async — intake never waits on it), transitions running → done/failed.
-- source_evidence = read-only evidence the adapter gathered (dry-run: the linked
-- companies row). evidence = the qualification signals that fired. verdict is the
-- machine call; a human can override it via the resolve endpoint (stored back here).
CREATE TABLE lead_enrichment_runs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id                UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','done','failed')),
  mode                   TEXT NOT NULL DEFAULT 'dry_run'
                         CHECK (mode IN ('dry_run','live')),
  source_evidence        JSONB NOT NULL DEFAULT '{}',   -- read-only evidence the adapter gathered
  score                  NUMERIC CHECK (score IS NULL OR (score >= 0 AND score <= 100)),  -- 0..100 qualification score
  verdict                TEXT CHECK (verdict IN ('qualified','disqualified','review')),
  evidence               JSONB NOT NULL DEFAULT '[]',    -- array of {code, weight, hit, detail} signals
  reason_codes           TEXT[] NOT NULL DEFAULT '{}',   -- machine reason tokens (localized client-side)
  suggested_owner_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  suggested_automation_id UUID,           -- Phase 5 automation binding (placeholder, no FK/trigger)
  suggested_asset_recipe TEXT,            -- Phase 4 asset recipe hint (placeholder)
  resolved_verdict       TEXT CHECK (resolved_verdict IN ('qualified','disqualified','review')),
  resolved_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_note          TEXT,
  resolved_at            TIMESTAMPTZ,
  error_reason           TEXT,
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_enrichment_runs_lead
  ON lead_enrichment_runs (tenant_id, lead_id, created_at DESC);
-- Review queue: verdict=review (and not yet human-resolved) per tenant, newest first.
CREATE INDEX idx_lead_enrichment_runs_review
  ON lead_enrichment_runs (tenant_id, created_at DESC)
  WHERE verdict = 'review' AND resolved_verdict IS NULL;
CREATE INDEX idx_lead_enrichment_runs_status
  ON lead_enrichment_runs (tenant_id, status);

-- ── updated_at trigger (shared helper, verbatim 121 pattern) ─────────────────
CREATE TRIGGER lead_enrichment_runs_updated_at
  BEFORE UPDATE ON lead_enrichment_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── tenant-consistency fence (121 leads_assert_tenant_consistency pattern) ────
-- Service-role code writes lead_id directly; this BEFORE trigger makes the lead
-- resolve to a row in the SAME tenant (defense in depth atop the app-layer
-- .eq('tenant_id') filters).
CREATE OR REPLACE FUNCTION lead_enrichment_runs_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'lead_enrichment_runs: lead % does not belong to tenant %', NEW.lead_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lead_enrichment_runs_tenant_consistency ON lead_enrichment_runs;
CREATE TRIGGER lead_enrichment_runs_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, lead_id ON lead_enrichment_runs
  FOR EACH ROW EXECUTE FUNCTION lead_enrichment_runs_assert_tenant_consistency();

-- ── RLS (verbatim 121 posture) ───────────────────────────────────────────────
ALTER TABLE lead_enrichment_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_enrichment_runs_select" ON lead_enrichment_runs FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "lead_enrichment_runs_insert" ON lead_enrichment_runs FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_enrichment_runs_update" ON lead_enrichment_runs FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_enrichment_runs_delete" ON lead_enrichment_runs FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

COMMENT ON TABLE lead_enrichment_runs IS
  'v3 WP2 CRM-owned enrichment+qualification run for a lead. Read-only adapter, DRY-RUN by default (no live scrape). Low-confidence verdict=review lands in the human review queue; never triggers outbound. Does NOT touch the research worker/queue schema.';

-- ── resolve_lead_enrichment (atomic human resolution) ────────────────────────
-- A human resolves ONE specific review run (qualify / disqualify) atomically:
-- the run row and the lead's qualification_status are updated inside a single
-- transaction (was two racy writes at the app layer). Idempotent-safe: it only
-- matches an UNRESOLVED, done, verdict='review' run for the tenant, so a double
-- click or a stale run_id resolves nothing → NULL return → the endpoint 409s.
-- Service-role-locked (REVOKE/GRANT + search_path=public), mirroring
-- complete_crm_task (115_crm_tasks_hardening.sql). NEVER triggers outbound.
CREATE OR REPLACE FUNCTION resolve_lead_enrichment(
  p_tenant_id UUID,
  p_run_id    UUID,
  p_resolver  UUID,
  p_verdict   TEXT,
  p_note      TEXT
) RETURNS lead_enrichment_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run lead_enrichment_runs;
BEGIN
  -- Defense in depth: the endpoint's Zod schema already narrows this, but the
  -- RPC must never write 'review' (that would drop the row from the queue while
  -- leaving the lead unresolved).
  IF p_verdict NOT IN ('qualified','disqualified') THEN
    RAISE EXCEPTION 'resolve_lead_enrichment: invalid verdict %', p_verdict
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE lead_enrichment_runs
     SET resolved_verdict = p_verdict,
         resolved_by      = p_resolver,
         resolved_note    = p_note,
         resolved_at      = now()
   WHERE id = p_run_id
     AND tenant_id = p_tenant_id
     AND status = 'done'
     AND verdict = 'review'
     AND resolved_verdict IS NULL
   RETURNING * INTO v_run;

  -- No matching resolvable run (wrong tenant/run, already resolved, or not a
  -- review verdict) → NULL so the endpoint can answer 409 without a lead write.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Same transaction: sync the lead's qualification_status to the human verdict
  -- (never lifecycle_status — identity review is a distinct queue).
  UPDATE leads
     SET qualification_status = p_verdict
   WHERE id = v_run.lead_id
     AND tenant_id = p_tenant_id;

  RETURN v_run;
END;
$$;

REVOKE EXECUTE ON FUNCTION resolve_lead_enrichment(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_lead_enrichment(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;

COMMENT ON FUNCTION resolve_lead_enrichment(UUID, UUID, UUID, TEXT, TEXT) IS
  'v3 WP2 atomic human resolution of a lead_enrichment_runs review row: updates the run + the lead qualification_status in one transaction. Returns the updated run, or NULL when nothing matched (endpoint maps NULL → 409). Service-role only.';
