-- ==========================================
-- Email Attachment Templates — reusable file
-- link cards that get embedded in reply HTML
-- ==========================================

CREATE TABLE email_attachment_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  file_type   TEXT NOT NULL DEFAULT 'pdf',
  file_url    TEXT NOT NULL,
  file_size   TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE email_attachment_templates ENABLE ROW LEVEL SECURITY;

-- ── Indexes ──

CREATE INDEX idx_att_templates_tenant
  ON email_attachment_templates(tenant_id, sort_order);

-- ── RLS Policies ──

CREATE POLICY "att_templates_select" ON email_attachment_templates
  FOR SELECT USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "att_templates_insert" ON email_attachment_templates
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "att_templates_update" ON email_attachment_templates
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "att_templates_delete" ON email_attachment_templates
  FOR DELETE USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

-- ── Trigger ──

CREATE TRIGGER set_att_templates_updated_at
  BEFORE UPDATE ON email_attachment_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
