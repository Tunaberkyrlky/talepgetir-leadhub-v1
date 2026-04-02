-- ==========================================
-- Email Reply Threading
-- Groups replies by (sender_email, campaign_id) to show one row per sender.
-- ==========================================

-- ── get_email_reply_threads ──
-- Returns the latest email per (sender_email, campaign_id) thread,
-- along with thread_count (total messages in thread) and has_unread.

CREATE OR REPLACE FUNCTION get_email_reply_threads(
  p_tenant_id    UUID,
  p_offset       INTEGER     DEFAULT 0,
  p_limit        INTEGER     DEFAULT 20,
  p_campaign_id  TEXT        DEFAULT NULL,
  p_match_status TEXT        DEFAULT NULL,
  p_read_status  TEXT        DEFAULT NULL,
  p_search       TEXT        DEFAULT NULL,
  p_date_from    TIMESTAMPTZ DEFAULT NULL,
  p_date_to      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(
  id                  UUID,
  tenant_id           UUID,
  campaign_id         TEXT,
  campaign_name       TEXT,
  sender_email        TEXT,
  reply_body          TEXT,
  replied_at          TIMESTAMPTZ,
  company_id          UUID,
  contact_id          UUID,
  match_status        TEXT,
  read_status         TEXT,
  category            TEXT,
  category_confidence REAL,
  raw_payload         JSONB,
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ,
  thread_count        BIGINT,
  has_unread          BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT *
    FROM email_replies
    WHERE tenant_id = p_tenant_id
      AND (p_campaign_id  IS NULL OR campaign_id  = p_campaign_id)
      AND (p_match_status IS NULL OR match_status = p_match_status)
      AND (p_search       IS NULL
           OR sender_email ILIKE '%' || p_search || '%'
           OR reply_body   ILIKE '%' || p_search || '%')
      AND (p_date_from IS NULL OR replied_at >= p_date_from)
      AND (p_date_to   IS NULL OR replied_at <= p_date_to)
  ),
  thread_stats AS (
    SELECT
      sender_email,
      campaign_id,
      COUNT(*)                              AS thread_count,
      BOOL_OR(read_status = 'unread')       AS has_unread
    FROM filtered
    GROUP BY sender_email, campaign_id
  ),
  latest AS (
    SELECT DISTINCT ON (f.sender_email, f.campaign_id) f.*
    FROM filtered f
    ORDER BY f.sender_email, f.campaign_id, f.replied_at DESC
  )
  SELECT
    l.id, l.tenant_id, l.campaign_id, l.campaign_name, l.sender_email,
    l.reply_body, l.replied_at, l.company_id, l.contact_id,
    l.match_status, l.read_status, l.category, l.category_confidence,
    l.raw_payload, l.created_at, l.updated_at,
    ts.thread_count, ts.has_unread
  FROM latest l
  JOIN thread_stats ts
    ON ts.sender_email = l.sender_email
   AND (ts.campaign_id = l.campaign_id
        OR (ts.campaign_id IS NULL AND l.campaign_id IS NULL))
  WHERE (
    p_read_status IS NULL
    OR (p_read_status = 'unread' AND ts.has_unread)
    OR (p_read_status = 'read'   AND NOT ts.has_unread)
  )
  ORDER BY l.replied_at DESC
  LIMIT p_limit OFFSET p_offset;
$$;

REVOKE ALL ON FUNCTION get_email_reply_threads FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_email_reply_threads TO authenticated;
GRANT EXECUTE ON FUNCTION get_email_reply_threads TO service_role;

-- ── count_email_reply_threads ──
-- Returns total thread count for pagination (mirrors filters of get_email_reply_threads).

CREATE OR REPLACE FUNCTION count_email_reply_threads(
  p_tenant_id    UUID,
  p_campaign_id  TEXT        DEFAULT NULL,
  p_match_status TEXT        DEFAULT NULL,
  p_read_status  TEXT        DEFAULT NULL,
  p_search       TEXT        DEFAULT NULL,
  p_date_from    TIMESTAMPTZ DEFAULT NULL,
  p_date_to      TIMESTAMPTZ DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH thread_agg AS (
    SELECT
      sender_email,
      campaign_id,
      BOOL_OR(read_status = 'unread') AS has_unread
    FROM email_replies
    WHERE tenant_id = p_tenant_id
      AND (p_campaign_id  IS NULL OR campaign_id  = p_campaign_id)
      AND (p_match_status IS NULL OR match_status = p_match_status)
      AND (p_search       IS NULL
           OR sender_email ILIKE '%' || p_search || '%'
           OR reply_body   ILIKE '%' || p_search || '%')
      AND (p_date_from IS NULL OR replied_at >= p_date_from)
      AND (p_date_to   IS NULL OR replied_at <= p_date_to)
    GROUP BY sender_email, campaign_id
  )
  SELECT COUNT(*)
  FROM thread_agg
  WHERE (
    p_read_status IS NULL
    OR (p_read_status = 'unread' AND has_unread)
    OR (p_read_status = 'read'   AND NOT has_unread)
  );
$$;

REVOKE ALL ON FUNCTION count_email_reply_threads FROM PUBLIC;
GRANT EXECUTE ON FUNCTION count_email_reply_threads TO authenticated;
GRANT EXECUTE ON FUNCTION count_email_reply_threads TO service_role;

-- ── Update get_email_reply_stats to count threads, not individual emails ──
-- Stats now reflect unique senders per campaign (threads) instead of raw message count.

CREATE OR REPLACE FUNCTION get_email_reply_stats(p_tenant_id UUID)
RETURNS TABLE(total BIGINT, unread BIGINT, matched BIGINT, unmatched BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (sender_email, campaign_id)
      match_status, read_status
    FROM email_replies
    WHERE tenant_id = p_tenant_id
    ORDER BY sender_email, campaign_id, replied_at DESC
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE read_status  = 'unread'),
    COUNT(*) FILTER (WHERE match_status = 'matched'),
    COUNT(*) FILTER (WHERE match_status = 'unmatched')
  FROM latest;
$$;
