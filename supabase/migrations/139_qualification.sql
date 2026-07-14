-- Tibexa CRM Expansion v2 — Phase 6 qualification fields + tags adopt  [139]
-- Slice E4. Two additive things, all idempotent (120/133 adapter posture):
--   1) Qualification columns on companies + deals (lead_source, priority,
--      qualification_status, a NUMERIC fit score, competitor/objection notes,
--      a standardized loss-reason code).
--   2) ADOPT the shared staging `tags` + `company_tags` tables (they already
--      carry live data — 3 tags + 1 link as of 2026-07-13). CREATE ... IF NOT
--      EXISTS so this is a no-op on staging and builds the tables verbatim on a
--      fresh DB; RLS/fence/trigger are added only when absent so staging's own
--      objects + its 13-Mantine-colour CHECK are NEVER clobbered.
--
-- FILE-ONLY: do NOT apply from this worktree — the orchestrator applies.
--
-- fit_score NOTE: companies.fit_score ALREADY EXISTS as a free-TEXT column
-- (validation z.string, a form TextInput, a detail render). `ADD COLUMN IF NOT
-- EXISTS fit_score int` would NO-OP there, so the int/CHECK would never apply.
-- We therefore add a SEPARATE numeric column `fit_score_num` (0-100); the legacy
-- text `fit_score` is left fully untouched.

-- ── companies: qualification columns (additive) ─────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lead_source          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS priority             TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qualification_status TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fit_score_num        INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS competitor_notes     TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS objection_notes      TEXT;

-- CHECKs added by name via a pg_constraint probe so a re-apply never errors on a
-- pre-existing constraint (inline CHECK on ADD COLUMN would not re-apply anyway).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_priority_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_priority_check
      CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_qualification_status_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_qualification_status_check
      CHECK (qualification_status IS NULL OR qualification_status IN ('unqualified', 'in_progress', 'qualified', 'disqualified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_fit_score_num_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_fit_score_num_check
      CHECK (fit_score_num IS NULL OR (fit_score_num BETWEEN 0 AND 100));
  END IF;
END $$;

-- ── deals: qualification columns (additive) ─────────────────────────────────
-- loss_reason (free-text, migration 133) is KEPT — loss_reason_code is the
-- standardized taxonomy that lives ALONGSIDE it.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lead_source      TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS priority         TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS loss_reason_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.deals'::regclass AND conname = 'deals_priority_check') THEN
    ALTER TABLE deals ADD CONSTRAINT deals_priority_check
      CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.deals'::regclass AND conname = 'deals_loss_reason_code_check') THEN
    ALTER TABLE deals ADD CONSTRAINT deals_loss_reason_code_check
      CHECK (loss_reason_code IS NULL OR loss_reason_code IN
        ('price', 'timing', 'competitor', 'no_budget', 'no_need', 'no_response', 'other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_companies_tenant_priority
  ON companies (tenant_id, priority) WHERE priority IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_tenant_qual_status
  ON companies (tenant_id, qualification_status) WHERE qualification_status IS NOT NULL;

-- ── capture pre-existence BEFORE the CREATE TABLEs ──────────────────────────
-- Whether tags / company_tags already existed is decided HERE (before the CREATE
-- ... IF NOT EXISTS below makes them exist regardless). The RLS-enable + policy
-- setup further down then runs ONLY on the fresh-table path, so a shared staging
-- table keeps its own policy set untouched (no permissive OR expansion).
CREATE TEMP TABLE _e4_pre AS
SELECT to_regclass('public.tags')         IS NULL AS tags_fresh,
       to_regclass('public.company_tags') IS NULL AS company_tags_fresh;

-- ── tags (shared staging table — CREATE only fires on a fresh DB) ───────────
-- Live staging shape (probed 2026-07-13): tenant-scoped tag with a colour drawn
-- from Mantine's default palette minus 'dark' (13 colours). Reproduced verbatim
-- so a fresh DB matches staging; on staging the CREATE + the CHECK are no-ops.
CREATE TABLE IF NOT EXISTS tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT 'blue'
             CHECK (color IN ('gray','red','pink','grape','violet','indigo','blue',
                              'cyan','teal','green','lime','yellow','orange')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tags_tenant ON tags (tenant_id);

-- ── company_tags (shared staging table — CREATE only fires on a fresh DB) ────
CREATE TABLE IF NOT EXISTS company_tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_company_tags_company ON company_tags (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_company_tags_tag ON company_tags (tenant_id, tag_id);

-- updated_at trigger on tags (only when absent; shared helper) ───────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tags'::regclass AND NOT tgisinternal
       AND tgname ILIKE '%updated_at%'
  ) AND EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'update_updated_at'
  ) THEN
    CREATE TRIGGER tags_updated_at
      BEFORE UPDATE ON tags
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ── company_tags tenant-consistency fence (114/133 pattern, additive) ───────
-- company_id AND tag_id must both live in the row's tenant. Own trigger name +
-- created only if absent so a shared staging table's own objects are untouched.
CREATE OR REPLACE FUNCTION company_tags_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.companies WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'company_tags: company % does not belong to tenant %', NEW.company_id, NEW.tenant_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tags WHERE id = NEW.tag_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'company_tags: tag % does not belong to tenant %', NEW.tag_id, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.company_tags'::regclass
       AND tgname = 'company_tags_tenant_consistency'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER company_tags_tenant_consistency
      BEFORE INSERT OR UPDATE OF tenant_id, company_id, tag_id ON public.company_tags
      FOR EACH ROW EXECUTE FUNCTION company_tags_assert_tenant_consistency();
  END IF;
END $$;

-- ── RLS (fresh-table ONLY — a shared staging table already carries its own RLS +
-- policies; touching them risks a permissive OR expansion, so we set RLS/policies
-- ONLY when this migration is the one that just CREATEd the table). ──────────────
DO $$
DECLARE
  tags_fresh         boolean;
  company_tags_fresh boolean;
BEGIN
  SELECT p.tags_fresh, p.company_tags_fresh
    INTO tags_fresh, company_tags_fresh
    FROM _e4_pre p;

  IF tags_fresh THEN
    ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "tags_select" ON tags FOR SELECT USING (
      tenant_id = get_user_tenant_id() OR is_superadmin());
    CREATE POLICY "tags_insert" ON tags FOR INSERT WITH CHECK (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
    CREATE POLICY "tags_update" ON tags FOR UPDATE USING (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
    CREATE POLICY "tags_delete" ON tags FOR DELETE USING (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
  END IF;

  IF company_tags_fresh THEN
    ALTER TABLE company_tags ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "company_tags_select" ON company_tags FOR SELECT USING (
      tenant_id = get_user_tenant_id() OR is_superadmin());
    CREATE POLICY "company_tags_insert" ON company_tags FOR INSERT WITH CHECK (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
    CREATE POLICY "company_tags_delete" ON company_tags FOR DELETE USING (
      (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
      OR is_superadmin());
  END IF;
END $$;

-- Table comments only when none is present (never clobber a shared table's own).
DO $$
BEGIN
  IF obj_description('public.tags'::regclass, 'pg_class') IS NULL THEN
    COMMENT ON TABLE tags IS 'Tenant-scoped labels (v2 Phase 6). color drawn from Mantine''s default palette minus dark.';
  END IF;
  IF obj_description('public.company_tags'::regclass, 'pg_class') IS NULL THEN
    COMMENT ON TABLE company_tags IS 'Company ⇄ tag links (v2 Phase 6). UNIQUE(company_id, tag_id).';
  END IF;
END $$;

DROP TABLE IF EXISTS _e4_pre;
