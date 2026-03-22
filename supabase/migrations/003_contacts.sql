-- ==========================================
-- Contacts table (final schema)
-- ==========================================

CREATE TABLE contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  title         TEXT,
  email         TEXT,
  phone_e164    TEXT,
  is_primary    BOOLEAN DEFAULT false,
  country       TEXT,
  seniority     TEXT,
  department    TEXT,
  linkedin      TEXT,
  notes         JSONB DEFAULT '[]'::jsonb,
  translations  JSONB DEFAULT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- INDEXES
-- ==========================================

CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX idx_contacts_company ON contacts(company_id);
CREATE INDEX idx_contacts_tenant_first_name ON contacts(tenant_id, first_name);
CREATE INDEX idx_contacts_tenant_email ON contacts(tenant_id, email);
CREATE INDEX idx_contacts_seniority ON contacts(tenant_id, seniority);
CREATE INDEX idx_contacts_department ON contacts(tenant_id, department);
CREATE INDEX idx_contacts_country ON contacts(tenant_id, country);
CREATE INDEX idx_contacts_tenant_company ON contacts(tenant_id, company_id);

-- ==========================================
-- RLS POLICIES
-- ==========================================

CREATE POLICY "contacts_select" ON contacts
  FOR SELECT USING (tenant_id = get_user_tenant_id());

CREATE POLICY "contacts_insert" ON contacts
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

CREATE POLICY "contacts_update" ON contacts
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

CREATE POLICY "contacts_delete" ON contacts
  FOR DELETE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() = 'superadmin'
  );

-- ==========================================
-- TRIGGERS
-- ==========================================

CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-update companies.contact_count when contacts change
CREATE OR REPLACE FUNCTION update_company_contact_count()
RETURNS TRIGGER AS $$
DECLARE
    target_company_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_company_id := OLD.company_id;
    ELSE
        target_company_id := NEW.company_id;
    END IF;

    UPDATE companies
    SET contact_count = (
        SELECT COUNT(*)::int FROM contacts WHERE company_id = target_company_id
    )
    WHERE id = target_company_id;

    -- Handle company_id change (moved contact to different company)
    IF TG_OP = 'UPDATE' AND OLD.company_id IS DISTINCT FROM NEW.company_id THEN
        UPDATE companies
        SET contact_count = (
            SELECT COUNT(*)::int FROM contacts WHERE company_id = OLD.company_id
        )
        WHERE id = OLD.company_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contact_count_insert
    AFTER INSERT ON contacts
    FOR EACH ROW
    EXECUTE FUNCTION update_company_contact_count();

CREATE TRIGGER trg_contact_count_delete
    AFTER DELETE ON contacts
    FOR EACH ROW
    EXECUTE FUNCTION update_company_contact_count();

CREATE TRIGGER trg_contact_count_update
    AFTER UPDATE ON contacts
    FOR EACH ROW
    EXECUTE FUNCTION update_company_contact_count();
