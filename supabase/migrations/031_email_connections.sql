-- ============================================================================
-- 031: Email Connections (Nango OAuth)
-- Tenant başına bir email hesabı bağlantısı (Gmail veya Outlook)
-- ============================================================================

CREATE TABLE email_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL CHECK (provider IN ('google-mail', 'microsoft-outlook')),
    email_address   TEXT NOT NULL,
    connection_id   TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    connected_at    TIMESTAMPTZ DEFAULT now(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(tenant_id)
);

CREATE TRIGGER email_connections_updated_at
    BEFORE UPDATE ON email_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE email_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant isolation" ON email_connections
    FOR ALL USING (tenant_id = get_user_tenant_id());
