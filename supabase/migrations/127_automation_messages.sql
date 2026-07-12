-- Tibexa CRM Expansion v3 — Phase 5 C3 messages ledger  [127]
-- The outbound/inbound MESSAGE ledger (v3 §6.7) that sits UNDER the channel adapters
-- (lib/channels/email.ts). Every send the automation email node attempts writes one row
-- here — REAL sends carry a provider_message_id; DRY-RUN / env-inert attempts land as
-- delivery_state='skipped' with a reason. A future inbound reply (C4 conversations)
-- lands as direction='inbound'; conversation_id is reserved NULL for that thread linkage.
--
-- GUARDRAIL: this migration adds SCHEMA ONLY. The email node is DRY-RUN by default and
-- the runtime tick is flag-gated OFF (AUTOMATION_WORKER_ENABLED) and unwired, so nothing
-- writes a real send row at rest. Rows written by the dry-run path carry provider_message_id
-- NULL (excluded from the idempotency UNIQUE) — their at-most-once is the action ledger's.
--
-- FILE-ONLY: do NOT apply from this worktree. On the shared staging DB the orchestrator
-- MUST first confirm the table name is free (parallel-worktree collision):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name = 'messages';
-- If it collides, an adapter is needed instead of this file. Depends on 126 (the
-- automation_runs / automation_actions FKs below reference it). Purely additive.
--
-- RLS/trigger posture copied verbatim from 123/124/125/126: tenant_id FK CASCADE, ENABLE
-- RLS, 4 policies (select = tenant OR superadmin; writes gate get_user_role() IN
-- superadmin/ops_agent/client_admin), SECURITY DEFINER tenant-consistency fence. The
-- channel adapter writes via supabaseAdmin (service role, bypasses RLS) with an explicit
-- tenant_id, so the DB-level fence is the real backstop.

-- ── messages ───────────────────────────────────────────────────────────────────
-- One outbound (or, later, inbound) message across any channel. Subject links
-- (lead/company/contact) are nullable so a non-automation / non-CRM message still
-- inserts. automation_run_id / automation_action_id tie a send back to the run + the
-- idempotent ledger row that produced it. delivery_state is the lifecycle:
--   queued → sent → delivered → read → replied  (happy path; adapters set what they know)
--   skipped   — dry-run OR an env-inert transport OR an unresolved sending identity
--   failed    — the provider rejected the send (error_reason carries why)
CREATE TABLE messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Subject links — all nullable (a system / non-CRM message has none).
  lead_id               UUID REFERENCES leads(id) ON DELETE SET NULL,
  company_id            UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id            UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Thread linkage — reserved for C4 conversations; no FK / catalog table yet.
  conversation_id       UUID,
  direction             TEXT NOT NULL DEFAULT 'outbound'
                        CHECK (direction IN ('outbound','inbound')),
  channel               TEXT NOT NULL
                        CHECK (channel IN ('email','whatsapp','sms')),
  provider              TEXT,                          -- 'resend' | 'smtp' | 'gmail' | … | NULL on dry-run
  provider_message_id   TEXT,                          -- external id; NULL on dry-run / skipped
  template_key          TEXT,
  subject               TEXT,
  body                  TEXT,                          -- inline body (when small)
  body_ref              TEXT,                          -- external ref (large body / stored elsewhere)
  delivery_state        TEXT NOT NULL DEFAULT 'queued'
                        CHECK (delivery_state IN ('queued','sent','delivered','read','replied','failed','skipped')),
  error_reason          TEXT,
  -- Automation linkage — nullable so a manual / non-automation send still inserts.
  automation_run_id     UUID REFERENCES automation_runs(id) ON DELETE SET NULL,
  automation_action_id  UUID REFERENCES automation_actions(id) ON DELETE SET NULL,
  sent_at               TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  read_at               TIMESTAMPTZ,
  replied_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inspector / run detail scan: messages for a run, newest first.
CREATE INDEX idx_messages_run
  ON messages (tenant_id, automation_run_id, created_at DESC)
  WHERE automation_run_id IS NOT NULL;
-- Subject timelines.
CREATE INDEX idx_messages_lead
  ON messages (tenant_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_messages_company
  ON messages (tenant_id, company_id) WHERE company_id IS NOT NULL;
-- IDEMPOTENCY (§6.7): a real send's provider_message_id is unique — a reconcile / retry
-- that re-observes the same provider id can never double-insert. Dry-run / skipped rows
-- have provider_message_id NULL (excluded here) and rely on the action ledger's
-- at-most-once instead.
CREATE UNIQUE INDEX uq_messages_provider_message_id
  ON messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- ── tenant-consistency fence (126 assert_tenant pattern) ─────────────────────────
-- Service-role code sets tenant_id + FK columns directly (bypassing RLS). Verify every
-- referenced parent row lives in the SAME tenant, so a cross-tenant pointer can never be
-- persisted. tenant_id is always NOT NULL. Defense in depth atop app-layer scoping.
CREATE OR REPLACE FUNCTION messages_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'messages: lead % is not in tenant %', NEW.lead_id, NEW.tenant_id;
  END IF;
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.companies WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'messages: company % is not in tenant %', NEW.company_id, NEW.tenant_id;
  END IF;
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.contacts WHERE id = NEW.contact_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'messages: contact % is not in tenant %', NEW.contact_id, NEW.tenant_id;
  END IF;
  IF NEW.automation_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.automation_runs WHERE id = NEW.automation_run_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'messages: automation_run % is not in tenant %', NEW.automation_run_id, NEW.tenant_id;
  END IF;
  IF NEW.automation_action_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.automation_actions WHERE id = NEW.automation_action_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'messages: automation_action % is not in tenant %', NEW.automation_action_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_tenant_consistency ON messages;
CREATE TRIGGER messages_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, lead_id, company_id, contact_id, automation_run_id, automation_action_id ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_assert_tenant();

-- updated_at touch (shared update_updated_at from earlier migrations).
CREATE TRIGGER messages_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── RLS (verbatim 123/124/125/126 posture) ──────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_select" ON messages FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "messages_insert" ON messages FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "messages_update" ON messages FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "messages_delete" ON messages FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

COMMENT ON TABLE messages IS
  'v3 §6.7 message ledger under the channel adapters. Outbound sends from the automation email node land here (real → provider_message_id set; dry-run/inert → delivery_state=skipped). Inbound replies (C4) land direction=inbound. provider_message_id UNIQUE (WHERE NOT NULL) is the reconcile idempotency; dry-run rows rely on the action ledger. Additive.';
