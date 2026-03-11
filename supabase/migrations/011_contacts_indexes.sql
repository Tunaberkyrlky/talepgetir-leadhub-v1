-- Indexes for efficient contact queries in PeoplePage (search, filter, sort)
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_first_name ON contacts(tenant_id, first_name);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_email ON contacts(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_seniority ON contacts(tenant_id, seniority);
CREATE INDEX IF NOT EXISTS idx_contacts_department ON contacts(tenant_id, department);
CREATE INDEX IF NOT EXISTS idx_contacts_country ON contacts(tenant_id, country);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(tenant_id, company_id);
