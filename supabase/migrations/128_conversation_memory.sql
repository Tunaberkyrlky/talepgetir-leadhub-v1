-- Tibexa CRM Expansion v3 — Phase 5 C4 conversation memory + context snapshots  [128]
-- The verifiable, current, goal-oriented CONTEXT layer for a lead (v3 §6.10, §10.5):
--   conversation_memory · memory_facts · generation_context_snapshots
-- A read-model (derived from observed facts) + an immutable per-message audit snapshot
-- ("why was this message generated this way"). This migration adds SCHEMA ONLY.
--
-- GUARDRAIL: nothing here runs an LLM or generates a message. conversation_memory is a
-- DETERMINISTIC read-model rebuilt from memory_facts (lib/context/memory.ts — a function
-- that exists but is NOT wired into any scheduler/tick; the night path never triggers a
-- rebuild). memory_facts is the raw observation ledger. generation_context_snapshots
-- records the DETERMINISTICALLY-assembled context (lib/context/assemble.ts) that a send
-- would use — it never carries a live send. Purely additive; touches no worker/queue schema.
--
-- FILE-ONLY: do NOT apply from this worktree. On the shared staging DB the orchestrator
-- MUST first confirm the three table names are free (parallel-worktree collision):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN
--        ('conversation_memory','memory_facts','generation_context_snapshots');
-- If any collides, an adapter is needed instead of this file. Depends on 121 (leads),
-- 124 (immutability pattern), 127 (messages — snapshots.message_id references it).
--
-- RLS/trigger posture copied verbatim from 124/127: tenant_id FK CASCADE, ENABLE RLS,
-- 4 policies (select = tenant OR superadmin; writes gate get_user_role() IN
-- superadmin/ops_agent/client_admin), SECURITY DEFINER tenant-consistency fence,
-- update_updated_at trigger. Service-role code (lib/context/*) writes via supabaseAdmin
-- with an explicit tenant_id, so the DB-level fence is the real backstop.

-- ── conversation_memory ──────────────────────────────────────────────────────────
-- One derived read-model row per (tenant, lead): the current, goal-oriented picture of
-- the relationship, folded DETERMINISTICALLY from memory_facts. The jsonb columns are the
-- structured summary; source_event_watermark is the observed_at high-water mark the
-- incremental rebuild has already folded in (so a rebuild only reprocesses newer facts).
-- Subject links (lead/contact/company) are nullable so a company-level or contact-level
-- memory can exist; UNIQUE is on (tenant_id, lead_id) for the lead-scoped read-model.
CREATE TABLE conversation_memory (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id                  UUID REFERENCES leads(id) ON DELETE SET NULL,
  contact_id               UUID REFERENCES contacts(id) ON DELETE SET NULL,
  company_id               UUID REFERENCES companies(id) ON DELETE SET NULL,
  relationship_summary     TEXT,
  goals                    JSONB NOT NULL DEFAULT '[]',
  pain_points              JSONB NOT NULL DEFAULT '[]',
  objections               JSONB NOT NULL DEFAULT '[]',
  preferences              JSONB NOT NULL DEFAULT '{}',
  forbidden_topics         JSONB NOT NULL DEFAULT '[]',
  past_qa                  JSONB NOT NULL DEFAULT '[]',
  our_commitments          JSONB NOT NULL DEFAULT '[]',
  their_commitments        JSONB NOT NULL DEFAULT '[]',
  last_meeting_summary     TEXT,
  open_tasks               JSONB NOT NULL DEFAULT '[]',
  last_meaningful_touch_at TIMESTAMPTZ,
  tone_language            TEXT,
  last_rebuilt_at          TIMESTAMPTZ,
  source_event_watermark   TIMESTAMPTZ,          -- max memory_facts.observed_at already folded in
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One lead-scoped read-model per lead. A TOTAL unique constraint (not a partial index) so the
-- read-model upsert can target it via PostgREST ON CONFLICT (tenant_id, lead_id) — PostgREST
-- cannot express a partial index's WHERE predicate, so a partial index here would make every
-- persist fail with "no unique or exclusion constraint matching the ON CONFLICT specification".
-- lead_id is nullable and Postgres treats NULLs as DISTINCT, so company/contact-only memories
-- (lead_id IS NULL) are still free to have many rows per tenant; only real lead ids are unique.
ALTER TABLE conversation_memory
  ADD CONSTRAINT uq_conversation_memory_lead UNIQUE (tenant_id, lead_id);
CREATE INDEX idx_conversation_memory_company
  ON conversation_memory (tenant_id, company_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_conversation_memory_touch
  ON conversation_memory (tenant_id, last_meaningful_touch_at DESC)
  WHERE last_meaningful_touch_at IS NOT NULL;

-- ── memory_facts ───────────────────────────────────────────────────────────────
-- The raw observation ledger the read-model is folded from. One fact = one observed
-- assertion about the lead (a goal, a pain point, an objection, a commitment, a Q&A,
-- a meeting summary, an open task, a preference…), tagged with WHERE it was observed
-- (source) and WHEN (observed_at). A later, corrected observation SUPERSEDES an older one
-- via superseded_by (self-FK): the CURRENT truth is the set of facts with superseded_by
-- IS NULL. human_pinned facts are operator-curated and always survive folding.
CREATE TABLE memory_facts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  memory_id        UUID REFERENCES conversation_memory(id) ON DELETE SET NULL,
  lead_id          UUID REFERENCES leads(id) ON DELETE SET NULL,
  fact_type        TEXT NOT NULL
                   CHECK (fact_type IN (
                     'goal','pain_point','objection','preference','forbidden_topic',
                     'commitment_ours','commitment_theirs','qa','meeting_summary',
                     'open_task','relationship','tone_language')),
  normalized_value JSONB NOT NULL DEFAULT '{}',      -- structured fact payload (never free instructions)
  source           TEXT NOT NULL
                   CHECK (source IN ('email','whatsapp','sms','form','meeting','task','human_note')),
  source_ref_id    UUID,                             -- message/task id the fact was observed in (no FK; polymorphic)
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by    UUID REFERENCES memory_facts(id) ON DELETE SET NULL,
  confidence       NUMERIC(4,3) NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  human_pinned     BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fold scan: current (not-superseded) facts for a lead, newest observation first.
CREATE INDEX idx_memory_facts_current
  ON memory_facts (tenant_id, lead_id, observed_at DESC)
  WHERE superseded_by IS NULL;
CREATE INDEX idx_memory_facts_memory
  ON memory_facts (tenant_id, memory_id) WHERE memory_id IS NOT NULL;
-- Operator-curated facts always survive folding — cheap lookup.
CREATE INDEX idx_memory_facts_pinned
  ON memory_facts (tenant_id, lead_id) WHERE human_pinned IS TRUE;

-- ── generation_context_snapshots ─────────────────────────────────────────────────
-- The immutable audit record of "why was THIS message generated this way": the exact
-- context that was assembled (§10.5) for a given produced message / automation action.
-- selected_memory_fact_ids pins which facts were in scope; recent_turns/open_commitments
-- capture the assembled slice; generated_message is what was produced. Written ONCE and
-- immutable thereafter (the generative columns are trigger-protected). approval_state /
-- human_edit_diff record a later human decision ON the snapshot (mutable metadata).
CREATE TABLE generation_context_snapshots (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id               UUID REFERENCES messages(id) ON DELETE SET NULL,
  automation_action_id     UUID REFERENCES automation_actions(id) ON DELETE SET NULL,
  lead_id                  UUID REFERENCES leads(id) ON DELETE SET NULL,
  memory_id                UUID REFERENCES conversation_memory(id) ON DELETE SET NULL,
  prompt_recipe_version    TEXT,                         -- which assembly recipe produced this
  selected_memory_fact_ids UUID[] NOT NULL DEFAULT '{}', -- facts in scope at generate time
  recent_turns             JSONB NOT NULL DEFAULT '[]',  -- the assembled conversation slice
  meeting_summary_version  TEXT,
  asset_engagement         JSONB NOT NULL DEFAULT '{}',
  open_commitments         JSONB NOT NULL DEFAULT '[]',
  generated_message        TEXT,                         -- what was produced (deterministic; no live LLM at night)
  human_edit_diff          JSONB NOT NULL DEFAULT '{}',  -- later human edit vs generated (mutable metadata)
  approval_state           TEXT NOT NULL DEFAULT 'draft'
                           CHECK (approval_state IN ('draft','pending','approved','rejected','edited','sent')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inspector lookups: snapshot for a message / action, and a lead's snapshot timeline.
CREATE INDEX idx_gcs_message
  ON generation_context_snapshots (tenant_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_gcs_action
  ON generation_context_snapshots (tenant_id, automation_action_id) WHERE automation_action_id IS NOT NULL;
CREATE INDEX idx_gcs_lead
  ON generation_context_snapshots (tenant_id, lead_id, created_at DESC) WHERE lead_id IS NOT NULL;

-- ── updated_at triggers (shared update_updated_at helper) ─────────────────────────
CREATE TRIGGER conversation_memory_updated_at
  BEFORE UPDATE ON conversation_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER memory_facts_updated_at
  BEFORE UPDATE ON memory_facts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
-- generation_context_snapshots is write-once (no updated_at column) — see immutability below.

-- ── tenant-consistency fences (124/127 assert_tenant pattern) ─────────────────────
-- Service-role code sets tenant_id + FK columns directly (bypassing RLS). Verify every
-- referenced parent row lives in the SAME tenant, so a cross-tenant pointer can never be
-- persisted. Nullable FKs are NULL-guarded. Defense in depth atop app-layer .eq(tenant_id).
CREATE OR REPLACE FUNCTION conversation_memory_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'conversation_memory: lead % is not in tenant %', NEW.lead_id, NEW.tenant_id;
  END IF;
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.contacts WHERE id = NEW.contact_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'conversation_memory: contact % is not in tenant %', NEW.contact_id, NEW.tenant_id;
  END IF;
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.companies WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'conversation_memory: company % is not in tenant %', NEW.company_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS conversation_memory_tenant_consistency ON conversation_memory;
CREATE TRIGGER conversation_memory_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, lead_id, contact_id, company_id ON conversation_memory
  FOR EACH ROW EXECUTE FUNCTION conversation_memory_assert_tenant();

CREATE OR REPLACE FUNCTION memory_facts_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.memory_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.conversation_memory WHERE id = NEW.memory_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'memory_facts: memory % is not in tenant %', NEW.memory_id, NEW.tenant_id;
  END IF;
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'memory_facts: lead % is not in tenant %', NEW.lead_id, NEW.tenant_id;
  END IF;
  IF NEW.superseded_by IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.memory_facts WHERE id = NEW.superseded_by AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'memory_facts: superseded_by % is not in tenant %', NEW.superseded_by, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS memory_facts_tenant_consistency ON memory_facts;
CREATE TRIGGER memory_facts_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, memory_id, lead_id, superseded_by ON memory_facts
  FOR EACH ROW EXECUTE FUNCTION memory_facts_assert_tenant();

CREATE OR REPLACE FUNCTION generation_context_snapshots_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.messages WHERE id = NEW.message_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'generation_context_snapshots: message % is not in tenant %', NEW.message_id, NEW.tenant_id;
  END IF;
  IF NEW.automation_action_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.automation_actions WHERE id = NEW.automation_action_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'generation_context_snapshots: automation_action % is not in tenant %', NEW.automation_action_id, NEW.tenant_id;
  END IF;
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'generation_context_snapshots: lead % is not in tenant %', NEW.lead_id, NEW.tenant_id;
  END IF;
  IF NEW.memory_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.conversation_memory WHERE id = NEW.memory_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'generation_context_snapshots: memory % is not in tenant %', NEW.memory_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS generation_context_snapshots_tenant_consistency ON generation_context_snapshots;
CREATE TRIGGER generation_context_snapshots_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, message_id, automation_action_id, lead_id, memory_id ON generation_context_snapshots
  FOR EACH ROW EXECUTE FUNCTION generation_context_snapshots_assert_tenant();

-- Snapshot immutability (124 generated_assets_snapshot_immutable pattern): the GENERATIVE
-- context is written ONCE and must never change afterwards, so "why this message was
-- generated" stays auditable. This BEFORE UPDATE trigger blocks any later mutation of the
-- generative columns, even via a direct Supabase UPDATE. approval_state / human_edit_diff
-- are intentionally NOT in the trigger's column list — a later human decision may update
-- them without disturbing the immutable generative record.
CREATE OR REPLACE FUNCTION generation_context_snapshots_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generated_message        IS DISTINCT FROM OLD.generated_message
     OR NEW.selected_memory_fact_ids IS DISTINCT FROM OLD.selected_memory_fact_ids
     OR NEW.recent_turns             IS DISTINCT FROM OLD.recent_turns
     OR NEW.open_commitments         IS DISTINCT FROM OLD.open_commitments
     OR NEW.asset_engagement         IS DISTINCT FROM OLD.asset_engagement
     OR NEW.prompt_recipe_version    IS DISTINCT FROM OLD.prompt_recipe_version
     OR NEW.meeting_summary_version  IS DISTINCT FROM OLD.meeting_summary_version THEN
    RAISE EXCEPTION 'generation_context_snapshots: generative context is immutable once written';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS generation_context_snapshots_immutable ON generation_context_snapshots;
CREATE TRIGGER generation_context_snapshots_immutable
  BEFORE UPDATE OF generated_message, selected_memory_fact_ids, recent_turns,
                   open_commitments, asset_engagement, prompt_recipe_version, meeting_summary_version
  ON generation_context_snapshots
  FOR EACH ROW EXECUTE FUNCTION generation_context_snapshots_immutable();

-- ── RLS (verbatim 124/127 posture) ────────────────────────────────────────────────
ALTER TABLE conversation_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_context_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_memory_select" ON conversation_memory FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "conversation_memory_insert" ON conversation_memory FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "conversation_memory_update" ON conversation_memory FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "conversation_memory_delete" ON conversation_memory FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

CREATE POLICY "memory_facts_select" ON memory_facts FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "memory_facts_insert" ON memory_facts FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "memory_facts_update" ON memory_facts FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "memory_facts_delete" ON memory_facts FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

CREATE POLICY "generation_context_snapshots_select" ON generation_context_snapshots FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "generation_context_snapshots_insert" ON generation_context_snapshots FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "generation_context_snapshots_update" ON generation_context_snapshots FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "generation_context_snapshots_delete" ON generation_context_snapshots FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

COMMENT ON TABLE conversation_memory IS
  'v3 §6.10 per-(tenant,lead) DETERMINISTIC read-model of the relationship, folded from memory_facts (lib/context/memory.ts). NO LLM: the rebuild is not wired to any scheduler. source_event_watermark is the observed_at high-water mark already folded in. Additive.';
COMMENT ON TABLE memory_facts IS
  'v3 §6.10 raw observation ledger the read-model is folded from. Current truth = superseded_by IS NULL; human_pinned facts always survive folding. normalized_value is structured source-data, never automation instructions (injection guard lives in lib/context/assemble.ts).';
COMMENT ON TABLE generation_context_snapshots IS
  'v3 §6.10/§10.5 immutable "why was this message generated this way" audit record: the assembled context (selected_memory_fact_ids, recent_turns, open_commitments) + generated_message. Generative columns are trigger-immutable once written; approval_state/human_edit_diff are mutable human metadata. No live send/LLM.';
