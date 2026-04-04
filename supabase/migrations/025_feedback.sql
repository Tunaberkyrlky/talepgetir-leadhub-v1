-- ==========================================
-- User Feedback table
-- Stores feature requests and bug reports
-- submitted by users from the app header.
-- ==========================================

CREATE TABLE feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  user_email  TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('feature_request', 'bug_report')),
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- ── Indexes ──

CREATE INDEX idx_feedback_tenant ON feedback(tenant_id);
CREATE INDEX idx_feedback_status ON feedback(status);
CREATE INDEX idx_feedback_type ON feedback(type);

-- ── RLS Policies ──

-- Everyone can read their own tenant's feedback; superadmin can read all
CREATE POLICY "feedback_select" ON feedback
  FOR SELECT USING (
    tenant_id = get_user_tenant_id() OR is_superadmin()
  );

-- Any authenticated user can submit feedback
CREATE POLICY "feedback_insert" ON feedback
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
  );

-- Only superadmin can update (status changes)
CREATE POLICY "feedback_update" ON feedback
  FOR UPDATE USING (
    is_superadmin()
  );

-- Only superadmin can delete
CREATE POLICY "feedback_delete" ON feedback
  FOR DELETE USING (
    is_superadmin()
  );

-- ── Trigger ──

CREATE TRIGGER set_feedback_updated_at
  BEFORE UPDATE ON feedback
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
