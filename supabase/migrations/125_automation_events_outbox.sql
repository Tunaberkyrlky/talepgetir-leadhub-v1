-- Tibexa CRM Expansion v3 — WP5 Automation runtime, event backbone  [125]
-- BEST-EFFORT outbox append (NOT yet a transactional outbox) for the multichannel
-- automation runtime (v3 §10.1). A business write (lead captured, lead qualified,
-- asset generated/published, …) appends ONE domain-event row here AFTER its own
-- commit, on a separate background emit. A later worker (Phase 5 C2 — NOT in this
-- migration) will claim queued rows and drive real actions. This round produces
-- event ROWS ONLY: there is no consumer, no scheduler, no send.
-- (v3 §10.1 event-driven core, §10.2 domain event catalog, §10.4 retry/idempotency,
--  §26 code org lib/automation/events.ts + outbox.ts)
--
-- HONESTY / LOSS WINDOW: this is NOT a real transactional outbox — the outbox
-- insert is a separate DB call after the business write, so a crash/restart/transient
-- error between the two loses the event (the emitter swallows this to protect the
-- business path — correct, but lossy). A real transactional outbox (business UPDATE
-- + outbox INSERT inside ONE service-role RPC / single txn) is DEFERRED to C2
-- hardening. The partial UNIQUE (tenant_id, dedup_key) only makes a REPEAT emit of
-- the same logical event a no-op (23505, swallowed) — it does NOT guarantee the
-- FIRST emit landed. So: idempotent-on-retry, but delivery is best-effort, NOT
-- at-least-once. GUARDRAIL: this table only records events. NO consumer/worker runs,
-- nothing is sent (email/WhatsApp/SMS/call). Purely additive; touches no other table.
--
-- FILE-ONLY: do NOT apply from this worktree. On the shared staging DB the
-- orchestrator MUST first confirm the name is free (parallel-worktree collision):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name = 'automation_events_outbox';
-- If it collides, an adapter is needed instead of this file.
--
-- RLS/trigger posture copied verbatim from 123/124: tenant_id FK CASCADE, ENABLE
-- RLS, 4 policies (select = tenant OR superadmin; writes gate get_user_role() IN
-- superadmin/ops_agent/client_admin). Writes are weighted to the service role
-- (the emitter uses supabaseAdmin with an explicit tenant_id).

-- ── automation_events_outbox ─────────────────────────────────────────────────
-- One domain event appended by a business write. aggregate_type/aggregate_id are
-- a POLYMORPHIC pointer (no FK — the referenced row may live in leads, companies,
-- contacts, generated_assets, …); the tenant-consistency trigger below validates
-- the known aggregate kinds. status drives the (future) claim lifecycle:
-- queued → claimed → processed | failed.
CREATE TABLE automation_events_outbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,                    -- from lib/automation/events.ts catalog
  aggregate_type TEXT                              -- lead/asset/company/contact/… (nullable)
                 -- Must match lib/automation/events.ts AGGREGATE_TYPES exactly. NULL
                 -- allowed (aggregate-less events); any other value is a bogus pointer.
                 CHECK (aggregate_type IS NULL OR aggregate_type IN
                   ('lead','company','contact','asset','message','booking','deal')),
  aggregate_id   UUID,                             -- polymorphic id, no FK (nullable)
  payload        JSONB NOT NULL DEFAULT '{}',
  dedup_key      TEXT,                             -- NULL ⇒ no idempotency key (always inserts)
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','claimed','processed','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  claimed_at     TIMESTAMPTZ,
  processed_at   TIMESTAMPTZ,
  error_reason   TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency ON RETRY: a repeat emit of the same logical event (same tenant +
-- dedup_key) hits this partial unique and returns 23505, which the emitter swallows.
-- NULL dedup_key rows are exempt (always insert). NOTE this only de-dupes a REPEAT
-- emit; it does NOT guarantee the FIRST emit landed (see loss-window note above), so
-- delivery stays best-effort — not at-least-once — until C2 makes it transactional.
CREATE UNIQUE INDEX uq_automation_events_outbox_dedup
  ON automation_events_outbox (tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Claim scan (Phase 5 C2): oldest queued events first, per status. Kept tenant-
-- agnostic so a single worker can drain across tenants; the RLS/emitter still scope
-- every row by tenant_id.
CREATE INDEX idx_automation_events_outbox_claim
  ON automation_events_outbox (status, occurred_at);
-- Per-tenant timeline lookups (admin/debug), newest first.
CREATE INDEX idx_automation_events_outbox_tenant
  ON automation_events_outbox (tenant_id, occurred_at DESC);

-- ── tenant-consistency fence (123/124 assert_tenant_consistency pattern) ──────
-- Service-role code writes aggregate_id directly. aggregate_id is polymorphic (no
-- FK), so validation dispatches on aggregate_type. A NULL aggregate (id OR type
-- NULL) is an aggregate-less event and passes. When aggregate_id IS NOT NULL we
-- REQUIRE a backing table: lead/company/contact/asset are tenant-verified against
-- their table; any OTHER type (message/booking/deal — tables that do NOT exist yet,
-- or any future kind without a validator) is REJECTED rather than silently accepted,
-- so a bogus/cross-tenant pointer can never slip into the outbox unvalidated (emit
-- errors are swallowed app-side, so this DB fence is the real backstop). tenant_id
-- is always required (NOT NULL). Defense in depth atop app-layer tenant scoping.
CREATE OR REPLACE FUNCTION automation_events_outbox_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Aggregate-less event (no pointer to verify): nothing to check.
  IF NEW.aggregate_id IS NULL OR NEW.aggregate_type IS NULL THEN
    RETURN NEW;
  END IF;

  -- aggregate_id present ⇒ its backing table MUST exist and the row MUST be this
  -- tenant's. Dispatch on type; the ELSE rejects any type without a validator here.
  IF NEW.aggregate_type = 'lead' THEN
    IF NOT EXISTS (SELECT 1 FROM public.leads WHERE id = NEW.aggregate_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'automation_events_outbox: lead % does not belong to tenant %', NEW.aggregate_id, NEW.tenant_id;
    END IF;
  ELSIF NEW.aggregate_type = 'company' THEN
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = NEW.aggregate_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'automation_events_outbox: company % does not belong to tenant %', NEW.aggregate_id, NEW.tenant_id;
    END IF;
  ELSIF NEW.aggregate_type = 'contact' THEN
    IF NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = NEW.aggregate_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'automation_events_outbox: contact % does not belong to tenant %', NEW.aggregate_id, NEW.tenant_id;
    END IF;
  ELSIF NEW.aggregate_type = 'asset' THEN
    IF NOT EXISTS (SELECT 1 FROM public.generated_assets WHERE id = NEW.aggregate_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'automation_events_outbox: asset % does not belong to tenant %', NEW.aggregate_id, NEW.tenant_id;
    END IF;
  ELSE
    -- message/booking/deal (and any future kind): no table to tenant-verify against
    -- yet, so an aggregate_id here cannot be validated. Reject instead of accepting a
    -- bogus/cross-tenant pointer. Emit aggregate-less until the table + a branch land.
    RAISE EXCEPTION 'automation_events_outbox: unsupported aggregate_type % with aggregate_id % until its table exists', NEW.aggregate_type, NEW.aggregate_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_events_outbox_tenant_consistency ON automation_events_outbox;
CREATE TRIGGER automation_events_outbox_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, aggregate_type, aggregate_id ON automation_events_outbox
  FOR EACH ROW EXECUTE FUNCTION automation_events_outbox_assert_tenant_consistency();

-- ── RLS (verbatim 123/124 posture) ───────────────────────────────────────────
ALTER TABLE automation_events_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY "automation_events_outbox_select" ON automation_events_outbox FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "automation_events_outbox_insert" ON automation_events_outbox FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automation_events_outbox_update" ON automation_events_outbox FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "automation_events_outbox_delete" ON automation_events_outbox FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

COMMENT ON TABLE automation_events_outbox IS
  'v3 WP5 BEST-EFFORT outbox for the automation runtime (NOT yet transactional). A business write appends one domain event (event_type from lib/automation/events.ts) on a separate background emit AFTER its own commit; a later worker (Phase 5 C2) claims queued rows. NO consumer/send in this migration. Idempotent ON RETRY via partial UNIQUE(tenant_id, dedup_key) — but the first emit is NOT guaranteed (crash/restart between the business write and this insert loses the event), so delivery is best-effort, not at-least-once. A real transactional outbox (business write + this insert in one RPC/txn) is deferred to C2. Purely additive.';
