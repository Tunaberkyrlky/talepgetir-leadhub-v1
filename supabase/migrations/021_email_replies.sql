-- ==========================================
-- Email Replies table (PlusVibe webhook data)
-- ==========================================

CREATE TABLE email_replies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_name        TEXT,
  campaign_id          TEXT,
  sender_email         TEXT NOT NULL,
  reply_body           TEXT,
  replied_at           TIMESTAMPTZ,
  company_id           UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id           UUID REFERENCES contacts(id) ON DELETE SET NULL,
  match_status         TEXT NOT NULL DEFAULT 'unmatched'
                         CHECK (match_status IN ('matched', 'unmatched')),
  read_status          TEXT NOT NULL DEFAULT 'unread'
                         CHECK (read_status IN ('unread', 'read')),
  category             TEXT CHECK (category IN (
                         'positive', 'negative', 'meeting_request',
                         'waiting_response', 'not_interested', 'other'
                       )),
  category_confidence  REAL,
  raw_payload          JSONB,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- Deduplication: prevent same reply event from being inserted twice
-- Use partial unique index (WHERE campaign_id IS NOT NULL) because NULL != NULL in PG unique constraints
CREATE UNIQUE INDEX idx_email_replies_dedup
  ON email_replies(campaign_id, sender_email, replied_at)
  WHERE campaign_id IS NOT NULL;

ALTER TABLE email_replies ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- INDEXES (composite, tenant-scoped)
-- ==========================================

CREATE INDEX idx_email_replies_tenant_replied
  ON email_replies(tenant_id, replied_at DESC);
CREATE INDEX idx_email_replies_tenant_match
  ON email_replies(tenant_id, match_status);
CREATE INDEX idx_email_replies_tenant_read
  ON email_replies(tenant_id, read_status);
CREATE INDEX idx_email_replies_tenant_company
  ON email_replies(tenant_id, company_id);
CREATE INDEX idx_email_replies_sender
  ON email_replies(sender_email);

-- ==========================================
-- RLS POLICIES (with superadmin override)
-- ==========================================

CREATE POLICY "email_replies_select" ON email_replies
  FOR SELECT USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "email_replies_insert" ON email_replies
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "email_replies_update" ON email_replies
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

CREATE POLICY "email_replies_delete" ON email_replies
  FOR DELETE USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

-- ==========================================
-- TRIGGER: auto-update updated_at
-- ==========================================

CREATE TRIGGER set_email_replies_updated_at
  BEFORE UPDATE ON email_replies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
