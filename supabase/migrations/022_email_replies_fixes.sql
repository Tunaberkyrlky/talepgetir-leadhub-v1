-- ==========================================
-- Email Replies — Security & Stats fixes
-- ==========================================

-- ── Issue 8: Add role-based checks to write policies ──
-- Only superadmin, ops_agent, and client_admin may insert/update/delete email replies.
-- client_viewer is read-only (SELECT policy in 021 already allows all tenant members to read).

DROP POLICY IF EXISTS "email_replies_insert" ON email_replies;
DROP POLICY IF EXISTS "email_replies_update" ON email_replies;
DROP POLICY IF EXISTS "email_replies_delete" ON email_replies;

CREATE POLICY "email_replies_insert" ON email_replies
  FOR INSERT WITH CHECK (
    (tenant_id = get_user_tenant_id()
      AND get_user_role() IN ('superadmin', 'ops_agent', 'client_admin'))
    OR is_superadmin()
  );

CREATE POLICY "email_replies_update" ON email_replies
  FOR UPDATE USING (
    (tenant_id = get_user_tenant_id()
      AND get_user_role() IN ('superadmin', 'ops_agent', 'client_admin'))
    OR is_superadmin()
  );

CREATE POLICY "email_replies_delete" ON email_replies
  FOR DELETE USING (
    (tenant_id = get_user_tenant_id()
      AND get_user_role() IN ('superadmin', 'ops_agent', 'client_admin'))
    OR is_superadmin()
  );

-- ── Issue 10: Single-query stats aggregation function ──
-- Replaces 4 separate COUNT queries with one index-efficient aggregation.
-- SECURITY DEFINER: bypasses RLS but tenant_id is explicitly filtered.

CREATE OR REPLACE FUNCTION get_email_reply_stats(p_tenant_id UUID)
RETURNS TABLE(total BIGINT, unread BIGINT, matched BIGINT, unmatched BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE read_status = 'unread'),
    COUNT(*) FILTER (WHERE match_status = 'matched'),
    COUNT(*) FILTER (WHERE match_status = 'unmatched')
  FROM email_replies
  WHERE tenant_id = p_tenant_id;
$$;

REVOKE ALL ON FUNCTION get_email_reply_stats(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_email_reply_stats(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_email_reply_stats(UUID) TO service_role;

-- ── Issue 15: Document future-use AI classification columns ──

COMMENT ON COLUMN email_replies.category IS
  'Future: AI classification category (not yet implemented). '
  'Allowed values: positive, negative, meeting_request, waiting_response, not_interested, other';

COMMENT ON COLUMN email_replies.category_confidence IS
  'Future: AI classification confidence score (0.0–1.0, not yet implemented). '
  'Populated alongside category when AI classification is added.';
