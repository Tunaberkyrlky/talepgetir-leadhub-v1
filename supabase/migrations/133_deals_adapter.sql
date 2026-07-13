-- Tibexa CRM Expansion v2 — Phase 5 Deal foundation (adapter)  [133]
-- A deal is a discrete commercial opportunity for a company (v2 §Phase 5, §5.3).
-- Same account can carry several concurrent deals, each with its own pipeline
-- stage + tasks + contacts.
--
-- FILE-ONLY: do NOT apply from this worktree — the orchestrator applies. The
-- shared staging DB ALREADY carries a `deals` table (cold-email worktree's
-- 067_deals, 0 rows) with columns/CHECKs/FKs/RLS/updated_at trigger. So this is
-- an ADAPTER (à la 120): every statement is IF NOT EXISTS / idempotent, their
-- table + policies + data are left untouched, and our additive columns
-- (stage_id / loss_reason / description), a tenant fence, the deal_contacts role
-- table and tasks.deal_id are layered on top.
--
-- On a FRESH DB built from this repo the CREATE TABLE below builds the base
-- table VERBATIM from the live staging shape (probed 2026-07-13):
--   status CHECK open/won/lost, currency NOT NULL DEFAULT 'USD' CHECK ^[A-Z]{3}$,
--   stage TEXT NOT NULL with composite FK (tenant_id, stage) -> pipeline_stages
--   (tenant_id, slug), owner/created_by -> auth.users. We DELIBERATELY keep the
--   existing NOT NULL `stage` slug column and ADD `stage_id` as the canonical uuid
--   reference; the deals route resolves stage_id -> slug and writes BOTH so the
--   composite FK stays satisfied and stage_id survives slug renames.

-- ── deals (base table — CREATE only fires on a fresh DB) ─────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES contacts(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  amount         NUMERIC,
  currency       TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  stage          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  expected_close DATE,
  owner          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by     UUID REFERENCES auth.users(id),
  closed_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_deals_stage FOREIGN KEY (tenant_id, stage)
    REFERENCES pipeline_stages(tenant_id, slug) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- ── Our additive columns (their table lacks them) ───────────────────────────
-- stage_id: canonical uuid reference to the pipeline stage. Kept in sync with the
-- NOT NULL `stage` slug by the route; immune to slug renames (id is stable).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_id UUID
  REFERENCES pipeline_stages(id) ON DELETE SET NULL;
-- loss_reason: set when a deal is closed as lost (required by the close route).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS loss_reason TEXT;
-- description: free-form opportunity notes.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS description TEXT;

-- ── Indexes (their idx_deals_* if any remain untouched) ─────────────────────
CREATE INDEX IF NOT EXISTS idx_deals_tenant_status ON deals (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_deals_tenant_company ON deals (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_deals_tenant_owner
  ON deals (tenant_id, owner) WHERE owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_tenant_stage
  ON deals (tenant_id, stage_id) WHERE stage_id IS NOT NULL;

-- ── updated_at trigger (only if the table has none; shared helper) ──────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.deals'::regclass AND NOT tgisinternal
       AND tgname ILIKE '%updated_at%'
  ) AND EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'update_updated_at'
  ) THEN
    CREATE TRIGGER deals_updated_at
      BEFORE UPDATE ON deals
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ── Tenant-consistency fence (114/115 tasks_assert pattern) ─────────────────
-- company_id MUST resolve to a company in the row's tenant; contact_id (when
-- present) MUST be a contact of that same company; stage_id (when present) MUST
-- be the pipeline stage of this tenant whose slug EQUALS the NOT NULL `stage`
-- column — i.e. stage_id and stage must name the SAME pipeline_stages row. This
-- closes the route's split-query race: the loser of a concurrent slug rename can
-- never persist a row where stage_id and stage disagree (the fence rejects it).
-- On an fk_deals_stage ON UPDATE CASCADE (slug rename), the cascade updates
-- `stage` to the new slug of that same row, so id+tenant+slug still align → pass.
-- owner is DELIBERATELY unchecked — internal roles (superadmin/ops_agent) may
-- legitimately own cross-tenant, same as tasks.assigned_to.
CREATE OR REPLACE FUNCTION deals_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.companies
     WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'deals: company % does not belong to tenant %', NEW.company_id, NEW.tenant_id;
  END IF;

  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts
     WHERE id = NEW.contact_id AND tenant_id = NEW.tenant_id AND company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'deals: contact % does not belong to company % in tenant %',
      NEW.contact_id, NEW.company_id, NEW.tenant_id;
  END IF;

  -- FOR SHARE locks the stage row so a concurrent slug rename (UPDATE on
  -- pipeline_stages) serializes against this fence: a stale id+slug snapshot
  -- cannot pass while the row is being renamed in another transaction.
  IF NEW.stage_id IS NOT NULL THEN
    PERFORM 1 FROM public.pipeline_stages
      WHERE id = NEW.stage_id AND tenant_id = NEW.tenant_id AND slug = NEW.stage
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'deals: stage_id % / slug % disagree or do not belong to tenant %',
        NEW.stage_id, NEW.stage, NEW.tenant_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_tenant_consistency ON public.deals;
CREATE TRIGGER deals_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, company_id, contact_id, stage_id, stage ON public.deals
  FOR EACH ROW EXECUTE FUNCTION deals_assert_tenant_consistency();

-- ── RLS (guarded — staging already has deals_select/insert/update/delete) ───
-- Postgres has no CREATE POLICY IF NOT EXISTS, and the shared table's policies
-- (tenant-scoped, role-gated writes) must NOT be overwritten. So each policy is
-- created ONLY when absent (fresh DB). ENABLE is idempotent.
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.deals'::regclass AND polname = 'deals_select') THEN
    CREATE POLICY "deals_select" ON deals FOR SELECT USING (
      tenant_id = get_user_tenant_id() OR is_superadmin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.deals'::regclass AND polname = 'deals_insert') THEN
    CREATE POLICY "deals_insert" ON deals FOR INSERT WITH CHECK (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.deals'::regclass AND polname = 'deals_update') THEN
    CREATE POLICY "deals_update" ON deals FOR UPDATE USING (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.deals'::regclass AND polname = 'deals_delete') THEN
    CREATE POLICY "deals_delete" ON deals FOR DELETE USING (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
  END IF;
END $$;

-- ── deal_contacts (deal ⇄ contact relationship roles, v2 §5.3) ──────────────
-- A contact's role on a specific deal. UNIQUE(deal_id, contact_id) so a contact
-- appears at most once per deal. Both FKs CASCADE on delete (a role row is
-- meaningless without its deal or contact). No updated_at — rows are replace-only.
CREATE TABLE IF NOT EXISTS deal_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id     UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role        TEXT CHECK (role IN ('decision_maker','influencer','champion','user','blocker')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deal_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_deal_contacts_deal ON deal_contacts (tenant_id, deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_contacts_contact ON deal_contacts (tenant_id, contact_id);

-- deal_id and contact_id must both resolve inside the row's tenant, AND the
-- contact must belong to the deal's OWN company — a deal's contacts cannot come
-- from a different account.
CREATE OR REPLACE FUNCTION deal_contacts_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.deals WHERE id = NEW.deal_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'deal_contacts: deal % does not belong to tenant %', NEW.deal_id, NEW.tenant_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.contacts WHERE id = NEW.contact_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'deal_contacts: contact % does not belong to tenant %', NEW.contact_id, NEW.tenant_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.contacts c
      JOIN public.deals d ON d.id = NEW.deal_id AND d.tenant_id = NEW.tenant_id
     WHERE c.id = NEW.contact_id
       AND c.tenant_id = NEW.tenant_id
       AND c.company_id = d.company_id
  ) THEN
    RAISE EXCEPTION 'deal_contacts: contact % does not belong to the company of deal % (tenant %)',
      NEW.contact_id, NEW.deal_id, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deal_contacts_tenant_consistency ON public.deal_contacts;
CREATE TRIGGER deal_contacts_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, deal_id, contact_id ON public.deal_contacts
  FOR EACH ROW EXECUTE FUNCTION deal_contacts_assert_tenant_consistency();

ALTER TABLE deal_contacts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.deal_contacts'::regclass AND polname = 'deal_contacts_select') THEN
    CREATE POLICY "deal_contacts_select" ON deal_contacts FOR SELECT USING (
      tenant_id = get_user_tenant_id() OR is_superadmin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.deal_contacts'::regclass AND polname = 'deal_contacts_insert') THEN
    CREATE POLICY "deal_contacts_insert" ON deal_contacts FOR INSERT WITH CHECK (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.deal_contacts'::regclass AND polname = 'deal_contacts_update') THEN
    CREATE POLICY "deal_contacts_update" ON deal_contacts FOR UPDATE USING (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.deal_contacts'::regclass AND polname = 'deal_contacts_delete') THEN
    CREATE POLICY "deal_contacts_delete" ON deal_contacts FOR DELETE USING (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
  END IF;
END $$;

-- ── tasks.deal_id (shared table — additive only, 120 adapter posture) ───────
-- Deal-scoped tasks. Nullable + ON DELETE SET NULL so existing company-scoped
-- tasks are unaffected and deleting a deal never deletes its tasks. Existing
-- tasks CHECKs / RLS / tenant-consistency trigger are DELIBERATELY untouched;
-- deal_id tenant/company consistency is enforced by the tasks route.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deal_id UUID
  REFERENCES deals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_deal
  ON tasks (tenant_id, deal_id) WHERE deal_id IS NOT NULL;

-- ── tasks.deal_id tenant/company fence (ADDITIVE — the shared tasks table's own
-- CHECKs / RLS / tenant-consistency trigger are DELIBERATELY untouched) ──────
-- When deal_id is set, the referenced deal MUST live in the task's tenant AND be
-- for the task's company. NULL deal_id (company-scoped tasks) is skipped, so
-- existing rows are unaffected. Own trigger name to avoid colliding with the
-- shared tasks triggers; created only if absent (pg_trigger probe) so a re-apply
-- never drops/recreates it.
CREATE OR REPLACE FUNCTION tasks_assert_deal_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.deal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.deals
     WHERE id = NEW.deal_id
       AND tenant_id = NEW.tenant_id
       AND company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'tasks: deal % does not belong to company % in tenant %',
      NEW.deal_id, NEW.company_id, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tasks'::regclass
       AND tgname = 'tasks_assert_deal_consistency'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tasks_assert_deal_consistency
      BEFORE INSERT OR UPDATE OF tenant_id, company_id, deal_id ON public.tasks
      FOR EACH ROW EXECUTE FUNCTION tasks_assert_deal_consistency();
  END IF;
END $$;

-- ── Table comments (deals is a SHARED table — do not clobber its existing
-- description; only set ours when none is present) ──────────────────────────
DO $$
BEGIN
  IF obj_description('public.deals'::regclass, 'pg_class') IS NULL THEN
    COMMENT ON TABLE deals IS
      'v2 Phase 5 commercial opportunity. stage (NOT NULL slug, composite FK) is kept in sync with stage_id (canonical uuid) by the deals route.';
  END IF;
END $$;
COMMENT ON TABLE deal_contacts IS
  'Contact roles on a deal (decision_maker/influencer/champion/user/blocker). UNIQUE(deal_id, contact_id).';
