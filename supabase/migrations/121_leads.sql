-- Tibexa CRM Expansion v3 — WP1 Lead foundation  [121]
-- Every acquisition intent from any source lands in CRM without loss:
--   leads · lead_sources · lead_forms · lead_submissions · lead_touchpoints
-- (v3 plan §6.1-6.4, §7.1-7.3).
--
-- FILE-ONLY: do NOT apply from this worktree. The shared staging DB carries
-- parallel-worktree tables (see 120's `tasks` adapter). Before apply the
-- orchestrator MUST confirm none of these five names already exist:
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN
--        ('leads','lead_sources','lead_forms','lead_submissions','lead_touchpoints');
-- If any collide, an adapter (à la 120) is needed instead of this file.
--
-- RLS/trigger posture copied from 114_crm_tasks.sql: tenant_id FK CASCADE,
-- ENABLE RLS, 4 policies (select = tenant OR superadmin; writes gate
-- get_user_role() IN superadmin/ops_agent/client_admin), update_updated_at trigger.
-- Server intake writes via service_role (bypasses RLS), so raw-payload
-- immutability is enforced by a BEFORE UPDATE trigger, NOT by an RLS policy.

-- ── lead_sources ─────────────────────────────────────────────────────────────
-- A configured origin of leads (a website, an ad account, an import, research…).
-- Default owner/automation are the per-source routing defaults (automation is a
-- Phase 5 placeholder — nullable, no FK to a table that does not exist yet).
CREATE TABLE lead_sources (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider               TEXT NOT NULL,
  source_type            TEXT NOT NULL DEFAULT 'website'
                         CHECK (source_type IN (
                           'cold_email','google_ads','meta_ads','youtube',
                           'website','whatsapp','import','research')),
  display_name           TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 500),
  default_owner_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  default_automation_id  UUID,            -- Phase 5 automation binding (placeholder)
  config                 JSONB NOT NULL DEFAULT '{}',
  is_active              BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_sources_tenant_active
  ON lead_sources (tenant_id, is_active);

-- ── lead_forms ───────────────────────────────────────────────────────────────
-- A public intake surface. public_slug is the ONLY tenant guard on the
-- unauthenticated intake endpoint, so it is a server-generated OPAQUE token
-- (crypto.randomBytes(18).base64url ⇒ 24 chars / 144-bit), NEVER a guessable
-- name, that is globally UNIQUE and resolves to exactly one tenant. Custom slugs
-- are NOT accepted on the form-create path.
-- field_mapping renames raw payload keys → normalized fields;
-- honeypot_field is the hidden anti-spam field (B3 will add Turnstile on top).
CREATE TABLE lead_forms (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id              UUID REFERENCES lead_sources(id) ON DELETE SET NULL,
  name                   TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 500),
  public_slug            TEXT NOT NULL CHECK (public_slug ~ '^[A-Za-z0-9_-]{16,64}$'),  -- opaque base64url token
  external_form_id       TEXT,
  field_mapping          JSONB NOT NULL DEFAULT '{}',
  honeypot_field         TEXT NOT NULL DEFAULT '_hp',
  consent_version        TEXT,
  consent_copy           TEXT,
  success_behavior       JSONB NOT NULL DEFAULT '{"type":"message"}',
  default_automation_id  UUID,            -- Phase 5 placeholder
  report_recipe_id       UUID,            -- Phase 4 asset placeholder
  is_active              BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_lead_forms_slug ON lead_forms (public_slug);
CREATE INDEX idx_lead_forms_tenant ON lead_forms (tenant_id, is_active);

-- ── leads ────────────────────────────────────────────────────────────────────
-- A lead is a specific acquisition intent — NOT the company/contact. The same
-- person can create multiple leads over time. company_id/contact_id are nullable
-- (identity_pending until resolution links or creates them; never fabricated).
-- raw_submission_id → lead_submissions is added by ALTER below (circular FK).
-- deal_id has no FK yet (deals table is a later phase).
CREATE TABLE leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id            UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id            UUID REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id               UUID,            -- future deals table (Phase D5)
  source_type           TEXT NOT NULL DEFAULT 'website'
                        CHECK (source_type IN (
                          'cold_email','google_ads','meta_ads','youtube',
                          'website','whatsapp','import','research')),
  source_id             UUID REFERENCES lead_sources(id) ON DELETE SET NULL,
  lead_form_id          UUID REFERENCES lead_forms(id) ON DELETE SET NULL,
  external_lead_id      TEXT,
  campaign_ref          TEXT,
  lifecycle_status      TEXT NOT NULL DEFAULT 'captured'
                        CHECK (lifecycle_status IN (
                          'captured','identity_pending','needs_review','processing_error')),
  qualification_status  TEXT CHECK (qualification_status IN (
                          'qualified','disqualified','needs_review')),  -- Phase 3, nullable
  score                 NUMERIC,          -- Phase 3 placeholder
  owner_id              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  match_method          TEXT,             -- how identity resolved (audit)
  review_reason         TEXT,
  raw_submission_id     UUID,             -- FK added post lead_submissions (circular)
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_engaged_at       TIMESTAMPTZ,
  booked_at             TIMESTAMPTZ,
  attended_at           TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leads_tenant_captured ON leads (tenant_id, captured_at DESC);
CREATE INDEX idx_leads_tenant_lifecycle ON leads (tenant_id, lifecycle_status);
CREATE INDEX idx_leads_tenant_company ON leads (tenant_id, company_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_leads_tenant_owner ON leads (tenant_id, owner_id) WHERE owner_id IS NOT NULL;

-- ── lead_submissions ─────────────────────────────────────────────────────────
-- The immutable record of a single intake event. raw_payload + UTM/click ids are
-- frozen by lead_submissions_guard_immutable(); processing columns stay mutable so
-- the pipeline can write its result. Partial UNIQUE (lead_form_id, external_lead_id)
-- is the provider dedup key: a duplicate provider event never yields a second lead.
CREATE TABLE lead_submissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_form_id       UUID REFERENCES lead_forms(id) ON DELETE SET NULL,
  source_id          UUID REFERENCES lead_sources(id) ON DELETE SET NULL,
  lead_id            UUID REFERENCES leads(id) ON DELETE SET NULL,
  raw_payload        JSONB NOT NULL,          -- IMMUTABLE (trigger-enforced)
  external_lead_id   TEXT,                    -- IMMUTABLE
  payload_fingerprint TEXT,                   -- sha256 of canonical raw_payload (organic dedup key)
  normalized         JSONB NOT NULL DEFAULT '{}',
  utm                JSONB NOT NULL DEFAULT '{}',   -- IMMUTABLE attribution
  gclid              TEXT,                    -- IMMUTABLE
  fbclid             TEXT,                    -- IMMUTABLE
  landing_url        TEXT,                    -- IMMUTABLE
  referrer           TEXT,                    -- IMMUTABLE
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- IMMUTABLE
  processing_status  TEXT NOT NULL DEFAULT 'pending'
                     CHECK (processing_status IN (
                       'pending','processing','processed','spam_suspect','error')),
  dedupe_result      TEXT,
  company_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         UUID REFERENCES contacts(id) ON DELETE SET NULL,
  test_lead          BOOLEAN NOT NULL DEFAULT false,
  error_reason       TEXT,
  review_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Provider dedup: partial so the many generic-form rows without an external id do
-- not collide on NULL (a NULL external_lead_id is legitimately "no provider key").
CREATE UNIQUE INDEX idx_lead_submissions_provider_dedup
  ON lead_submissions (lead_form_id, external_lead_id)
  WHERE external_lead_id IS NOT NULL;
-- Organic dedup: with NO provider id, a same-day re-submit of an identical payload
-- must NOT spawn a second lead. Keyed on the canonical-payload fingerprint per form
-- per UTC day. date_trunc uses `submitted_at AT TIME ZONE 'UTC'` (timestamp WITHOUT
-- tz) because the timestamptz form of date_trunc is only STABLE — an index
-- expression must be IMMUTABLE, and the UTC-cast form is.
CREATE UNIQUE INDEX idx_lead_submissions_organic_dedup
  ON lead_submissions (
    tenant_id, lead_form_id, payload_fingerprint,
    date_trunc('day', submitted_at AT TIME ZONE 'UTC')
  )
  WHERE external_lead_id IS NULL AND payload_fingerprint IS NOT NULL;
CREATE INDEX idx_lead_submissions_tenant_submitted
  ON lead_submissions (tenant_id, submitted_at DESC);
CREATE INDEX idx_lead_submissions_tenant_status
  ON lead_submissions (tenant_id, processing_status);

-- Close the circular reference now that both tables exist.
ALTER TABLE leads
  ADD CONSTRAINT leads_raw_submission_fk
  FOREIGN KEY (raw_submission_id) REFERENCES lead_submissions(id) ON DELETE SET NULL;

-- ── lead_touchpoints ─────────────────────────────────────────────────────────
-- First-touch / multi-touch attribution rows for a lead (v3 §6.4).
CREATE TABLE lead_touchpoints (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      UUID REFERENCES leads(id) ON DELETE CASCADE,
  company_id   UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id   UUID REFERENCES contacts(id) ON DELETE SET NULL,
  source       TEXT,
  medium       TEXT,
  campaign     TEXT,
  content      TEXT,
  term         TEXT,
  gclid        TEXT,
  fbclid       TEXT,
  landing_url  TEXT,
  referrer     TEXT,
  event_type   TEXT NOT NULL DEFAULT 'form_submit',
  event_time   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_touchpoints_lead ON lead_touchpoints (tenant_id, lead_id);
CREATE INDEX idx_lead_touchpoints_tenant_time ON lead_touchpoints (tenant_id, event_time DESC);

-- ── updated_at triggers (shared helper, verbatim 114 pattern) ────────────────
CREATE TRIGGER lead_sources_updated_at
  BEFORE UPDATE ON lead_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER lead_forms_updated_at
  BEFORE UPDATE ON lead_forms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── raw-payload immutability fence ───────────────────────────────────────────
-- Service-role intake bypasses RLS; this trigger is what actually protects the
-- source-of-truth capture. Processing columns (status, lead/company/contact ids,
-- dedupe_result, error/review reason, normalized) stay mutable.
CREATE OR REPLACE FUNCTION lead_submissions_guard_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.raw_payload      IS DISTINCT FROM OLD.raw_payload
     OR NEW.utm           IS DISTINCT FROM OLD.utm
     OR NEW.external_lead_id IS DISTINCT FROM OLD.external_lead_id
     OR NEW.gclid         IS DISTINCT FROM OLD.gclid
     OR NEW.fbclid        IS DISTINCT FROM OLD.fbclid
     OR NEW.landing_url   IS DISTINCT FROM OLD.landing_url
     OR NEW.referrer      IS DISTINCT FROM OLD.referrer
     OR NEW.submitted_at  IS DISTINCT FROM OLD.submitted_at
  THEN
    RAISE EXCEPTION 'lead_submissions: raw capture (payload/attribution) is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lead_submissions_immutable
  BEFORE UPDATE ON lead_submissions
  FOR EACH ROW EXECUTE FUNCTION lead_submissions_guard_immutable();

-- ── tenant-consistency fences (120 tasks_assert_tenant_consistency pattern) ───
-- Service-role intake writes cross-table FKs directly; these BEFORE triggers make
-- every non-null FK on a lead / lead_submission resolve to a row in the SAME
-- tenant (defense in depth atop the app-layer .eq('tenant_id') filters). Two small
-- specific functions (one per table) for readability.
CREATE OR REPLACE FUNCTION leads_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companies WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'leads: company % does not belong to tenant %', NEW.company_id, NEW.tenant_id;
  END IF;

  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts WHERE id = NEW.contact_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'leads: contact % does not belong to tenant %', NEW.contact_id, NEW.tenant_id;
  END IF;

  IF NEW.lead_form_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lead_forms WHERE id = NEW.lead_form_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'leads: lead_form % does not belong to tenant %', NEW.lead_form_id, NEW.tenant_id;
  END IF;

  IF NEW.source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lead_sources WHERE id = NEW.source_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'leads: source % does not belong to tenant %', NEW.source_id, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_tenant_consistency ON leads;
CREATE TRIGGER leads_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, company_id, contact_id, lead_form_id, source_id ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_assert_tenant_consistency();

CREATE OR REPLACE FUNCTION lead_submissions_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.lead_form_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lead_forms WHERE id = NEW.lead_form_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'lead_submissions: lead_form % does not belong to tenant %', NEW.lead_form_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lead_submissions_tenant_consistency ON lead_submissions;
CREATE TRIGGER lead_submissions_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, lead_form_id ON lead_submissions
  FOR EACH ROW EXECUTE FUNCTION lead_submissions_assert_tenant_consistency();

-- ── RLS (verbatim 114 posture) ───────────────────────────────────────────────
ALTER TABLE lead_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_touchpoints ENABLE ROW LEVEL SECURITY;

-- lead_sources
CREATE POLICY "lead_sources_select" ON lead_sources FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "lead_sources_insert" ON lead_sources FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_sources_update" ON lead_sources FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_sources_delete" ON lead_sources FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

-- lead_forms
CREATE POLICY "lead_forms_select" ON lead_forms FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "lead_forms_insert" ON lead_forms FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_forms_update" ON lead_forms FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_forms_delete" ON lead_forms FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

-- leads
CREATE POLICY "leads_select" ON leads FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "leads_insert" ON leads FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "leads_update" ON leads FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "leads_delete" ON leads FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

-- lead_submissions
CREATE POLICY "lead_submissions_select" ON lead_submissions FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "lead_submissions_insert" ON lead_submissions FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_submissions_update" ON lead_submissions FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_submissions_delete" ON lead_submissions FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

-- lead_touchpoints
CREATE POLICY "lead_touchpoints_select" ON lead_touchpoints FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "lead_touchpoints_insert" ON lead_touchpoints FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_touchpoints_update" ON lead_touchpoints FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "lead_touchpoints_delete" ON lead_touchpoints FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

COMMENT ON TABLE leads IS
  'v3 acquisition intent. NOT the company/contact — the same person can create many leads. Identity resolution links or creates company_id/contact_id; never fabricated.';
COMMENT ON TABLE lead_submissions IS
  'Immutable raw intake capture (raw_payload/attribution frozen by trigger). Provider dedup: UNIQUE(lead_form_id, external_lead_id) WHERE external_lead_id IS NOT NULL.';
COMMENT ON COLUMN leads.raw_submission_id IS
  'Source submission. FK added after lead_submissions to break the circular reference.';
