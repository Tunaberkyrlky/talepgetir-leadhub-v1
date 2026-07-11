-- Tibexa CRM Expansion v3 — WP3 Asset foundation  [124]
-- Personalized report / lead-magnet engine foundation. A recipe (asset_recipes)
-- describes what to build (input requirements, template/theme, CTA, output kind,
-- approval policy). A generated_assets row is one produced asset for a lead /
-- company / contact: structured_content JSON (never free LLM HTML — the renderer
-- turns structured JSON into a fixed template, v3 §9.3), a rendered HTML payload
-- (kept inline in the DB when R2 storage is inert), and a manual approve → publish
-- lifecycle. asset_events is the read-model skeleton for view/CTA telemetry.
-- (v3 plan §6.5 tables, §9 report engine + approval policy, §27/WP3, §26 code org
--  lib/assets/generator.ts + renderer.ts + routes/assets/)
--
-- GUARDRAIL: generation is DRY-RUN by default (ASSET_LLM_LIVE unset ⇒ deterministic
-- template/stub structured JSON, NO LLM call, COGS $0). The R2 upload adapter is
-- ENV-GATED INERT (no R2_* env ⇒ no-op, rendered_html stays inline). Nothing here
-- sends email or touches the research worker/queue schema. Purely additive.
--
-- FILE-ONLY: do NOT apply from this worktree. On the shared staging DB the
-- orchestrator MUST first confirm the names are free (parallel-worktree collision):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN ('asset_recipes','generated_assets','asset_events');
-- If any collides, an adapter is needed instead of this file.
--
-- RLS/trigger posture copied verbatim from 123_lead_enrichment.sql: tenant_id FK
-- CASCADE, ENABLE RLS, 4 policies (select = tenant OR superadmin; writes gate
-- get_user_role() IN superadmin/ops_agent/client_admin), update_updated_at trigger,
-- SECURITY DEFINER BEFORE trigger asserting cross-table FKs stay in one tenant.

-- ── asset_recipes ─────────────────────────────────────────────────────────────
-- A per-tenant recipe: what evidence it needs, which template/theme renders it,
-- CTA config, output kind, and the approval policy. `prompt_template` is the seam
-- for the LIVE (LLM) generator — the dry-run generator never reads it.
CREATE TABLE asset_recipes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key                 TEXT NOT NULL,                     -- stable per-tenant recipe key
  name                TEXT NOT NULL,
  description         TEXT,
  input_requirements  JSONB NOT NULL DEFAULT '{}',       -- {requires: [...], optional: [...]}
  prompt_template     TEXT,                              -- LIVE path only (dry-run ignores it)
  schema_version      INTEGER NOT NULL DEFAULT 1,        -- snapshotted onto each generated asset
  template            TEXT NOT NULL DEFAULT 'default',   -- renderer template id
  theme               JSONB NOT NULL DEFAULT '{}',       -- tenant theme tokens (colors, etc.)
  cta_config          JSONB NOT NULL DEFAULT '{}',       -- {label, url, booking_url}
  output_kind         TEXT NOT NULL DEFAULT 'html'
                      CHECK (output_kind IN ('html','pdf','json')),
  approval_policy     TEXT NOT NULL DEFAULT 'manual'
                      CHECK (approval_policy IN ('manual','sampled','automatic')),
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','inactive','draft')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX idx_asset_recipes_tenant_status ON asset_recipes (tenant_id, status);

-- ── generated_assets ──────────────────────────────────────────────────────────
-- One produced asset. source_evidence_snapshot is written ONCE at generate time
-- and is immutable thereafter, so a given recipe+version is auditable. rendered_html
-- holds the inline HTML when R2 is inert; rendered_html_key holds the R2 object key
-- when the (env-gated) upload adapter is configured. Manual approve → publish:
-- published_at stays NULL until approved_by/at are set (enforced at the route).
CREATE TABLE generated_assets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipe_id                UUID NOT NULL REFERENCES asset_recipes(id) ON DELETE CASCADE,
  recipe_version           INTEGER NOT NULL DEFAULT 1,   -- snapshot of recipe.schema_version
  lead_id                  UUID REFERENCES leads(id) ON DELETE SET NULL,
  company_id               UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id               UUID REFERENCES contacts(id) ON DELETE SET NULL,
  source_evidence_snapshot JSONB NOT NULL DEFAULT '{}',  -- immutable, write-once at generate
  status                   TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','generating','generated','failed')),
  structured_content       JSONB,                        -- structured JSON (renderer input)
  rendered_html            TEXT,                         -- inline HTML when R2 inert
  rendered_html_key        TEXT,                         -- R2 object key when uploaded
  pdf_key                  TEXT,                         -- PDF object key (placeholder)
  delivery_mode            TEXT NOT NULL DEFAULT 'gated'
                           CHECK (delivery_mode IN ('public','gated')),
  access_slug              TEXT UNIQUE,                  -- opaque public/gated view slug
  token_version            INTEGER NOT NULL DEFAULT 1,   -- bump to revoke a gated link
  cta_url                  TEXT,
  booking_url              TEXT,
  error_reason             TEXT,
  approved_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at              TIMESTAMPTZ,
  published_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Approve → publish invariant at the DB layer (defense in depth): an asset can
  -- never carry a published_at without an approved_at. This holds even against a
  -- direct/broad UPDATE via the Supabase path, not only the app-route gate.
  CONSTRAINT generated_assets_publish_requires_approval
    CHECK (published_at IS NULL OR approved_at IS NOT NULL)
);

CREATE INDEX idx_generated_assets_status  ON generated_assets (tenant_id, status);
CREATE INDEX idx_generated_assets_recipe  ON generated_assets (tenant_id, recipe_id);
CREATE INDEX idx_generated_assets_lead    ON generated_assets (tenant_id, lead_id)    WHERE lead_id IS NOT NULL;
CREATE INDEX idx_generated_assets_company ON generated_assets (tenant_id, company_id) WHERE company_id IS NOT NULL;
-- Published-asset lookup (delivery), newest first.
CREATE INDEX idx_generated_assets_published
  ON generated_assets (tenant_id, published_at DESC)
  WHERE published_at IS NOT NULL;
-- Approval queue: generated but not yet approved.
CREATE INDEX idx_generated_assets_pending_approval
  ON generated_assets (tenant_id, created_at DESC)
  WHERE status = 'generated' AND approved_at IS NULL;

-- ── asset_events ──────────────────────────────────────────────────────────────
-- View / CTA telemetry read-model skeleton. No real traffic is generated here; the
-- ingest endpoint is a tenant-scoped skeleton for a later public delivery surface.
CREATE TABLE asset_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  generated_asset_id UUID NOT NULL REFERENCES generated_assets(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL
                     CHECK (event_type IN (
                       'viewed','unique_viewed','section_reached',
                       'cta_clicked','pdf_downloaded','booking_opened','booking_completed')),
  meta               JSONB NOT NULL DEFAULT '{}',
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_asset_events_asset
  ON asset_events (tenant_id, generated_asset_id, occurred_at DESC);

-- ── updated_at triggers (shared helper, verbatim 121/123 pattern) ─────────────
CREATE TRIGGER asset_recipes_updated_at
  BEFORE UPDATE ON asset_recipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER generated_assets_updated_at
  BEFORE UPDATE ON generated_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── tenant-consistency fences (123 assert_tenant_consistency pattern) ─────────
-- Service-role code writes FKs directly; these BEFORE triggers make every linked
-- row resolve within the SAME tenant (defense in depth atop the app-layer
-- .eq('tenant_id') filters). Nullable FKs are NULL-guarded.
CREATE OR REPLACE FUNCTION generated_assets_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.recipe_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.asset_recipes WHERE id = NEW.recipe_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'generated_assets: recipe % does not belong to tenant %', NEW.recipe_id, NEW.tenant_id;
  END IF;
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'generated_assets: lead % does not belong to tenant %', NEW.lead_id, NEW.tenant_id;
  END IF;
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companies WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'generated_assets: company % does not belong to tenant %', NEW.company_id, NEW.tenant_id;
  END IF;
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts WHERE id = NEW.contact_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'generated_assets: contact % does not belong to tenant %', NEW.contact_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS generated_assets_tenant_consistency ON generated_assets;
CREATE TRIGGER generated_assets_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, recipe_id, lead_id, company_id, contact_id ON generated_assets
  FOR EACH ROW EXECUTE FUNCTION generated_assets_assert_tenant_consistency();

-- source_evidence_snapshot immutability (defense in depth): the snapshot is written
-- ONCE at generate time and must never change afterwards, so a recipe+version stays
-- auditable. This BEFORE UPDATE trigger allows the initial write (default '{}' → real
-- snapshot) but blocks any later mutation, even via a direct Supabase UPDATE.
CREATE OR REPLACE FUNCTION generated_assets_snapshot_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_evidence_snapshot IS NOT NULL
     AND OLD.source_evidence_snapshot <> '{}'::jsonb
     AND NEW.source_evidence_snapshot IS DISTINCT FROM OLD.source_evidence_snapshot THEN
    RAISE EXCEPTION 'generated_assets: source_evidence_snapshot is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS generated_assets_snapshot_immutable ON generated_assets;
CREATE TRIGGER generated_assets_snapshot_immutable
  BEFORE UPDATE OF source_evidence_snapshot ON generated_assets
  FOR EACH ROW EXECUTE FUNCTION generated_assets_snapshot_immutable();

CREATE OR REPLACE FUNCTION asset_events_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.generated_asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.generated_assets WHERE id = NEW.generated_asset_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'asset_events: asset % does not belong to tenant %', NEW.generated_asset_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS asset_events_tenant_consistency ON asset_events;
CREATE TRIGGER asset_events_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, generated_asset_id ON asset_events
  FOR EACH ROW EXECUTE FUNCTION asset_events_assert_tenant_consistency();

-- ── RLS (verbatim 123 posture) ────────────────────────────────────────────────
ALTER TABLE asset_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asset_recipes_select" ON asset_recipes FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "asset_recipes_insert" ON asset_recipes FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "asset_recipes_update" ON asset_recipes FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "asset_recipes_delete" ON asset_recipes FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

CREATE POLICY "generated_assets_select" ON generated_assets FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "generated_assets_insert" ON generated_assets FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "generated_assets_update" ON generated_assets FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "generated_assets_delete" ON generated_assets FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

CREATE POLICY "asset_events_select" ON asset_events FOR SELECT USING (
  tenant_id = get_user_tenant_id() OR is_superadmin());
CREATE POLICY "asset_events_insert" ON asset_events FOR INSERT WITH CHECK (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "asset_events_update" ON asset_events FOR UPDATE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());
CREATE POLICY "asset_events_delete" ON asset_events FOR DELETE USING (
  (tenant_id = get_user_tenant_id() AND get_user_role() IN ('superadmin','ops_agent','client_admin'))
  OR is_superadmin());

COMMENT ON TABLE asset_recipes IS
  'v3 WP3 personalized asset recipe (template/theme, CTA, output kind, approval policy). prompt_template is the LIVE-generator seam; the dry-run generator ignores it.';
COMMENT ON TABLE generated_assets IS
  'v3 WP3 one produced asset for a lead/company/contact. DRY-RUN by default (deterministic structured JSON, no LLM). source_evidence_snapshot is immutable (write-once). Manual approve → publish: published_at stays NULL until approved. R2 storage is env-gated inert (rendered_html kept inline).';
COMMENT ON TABLE asset_events IS
  'v3 WP3 view/CTA telemetry read-model skeleton for generated assets. Tenant-scoped; no real traffic generated here.';
