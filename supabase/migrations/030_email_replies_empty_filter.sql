-- Support filtering by empty label/sentiment (p_label = '__EMPTY__' → label IS NULL)

CREATE OR REPLACE FUNCTION get_email_reply_threads(
  p_tenant_id    UUID,
  p_offset       INTEGER     DEFAULT 0,
  p_limit        INTEGER     DEFAULT 20,
  p_campaign_id  TEXT        DEFAULT NULL,
  p_match_status TEXT        DEFAULT NULL,
  p_read_status  TEXT        DEFAULT NULL,
  p_search       TEXT        DEFAULT NULL,
  p_date_from    TIMESTAMPTZ DEFAULT NULL,
  p_date_to      TIMESTAMPTZ DEFAULT NULL,
  p_label        TEXT        DEFAULT NULL,
  p_sentiment    TEXT        DEFAULT NULL
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
  has_unread          BOOLEAN,
  label               TEXT,
  sentiment           TEXT,
  subject             TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH all_msgs AS (
    SELECT *
    FROM email_replies
    WHERE tenant_id = p_tenant_id
      AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id)
      AND (p_search IS NULL
           OR sender_email ILIKE '%' || p_search || '%'
           OR reply_body   ILIKE '%' || p_search || '%')
      AND (p_date_from IS NULL OR replied_at >= p_date_from)
      AND (p_date_to   IS NULL OR replied_at <= p_date_to)
  ),
  filtered_in AS (
    SELECT * FROM all_msgs
    WHERE direction = 'IN'
      AND (p_match_status IS NULL OR match_status = p_match_status)
      AND (p_label IS NULL OR (p_label = '__EMPTY__' AND all_msgs.label IS NULL) OR (p_label <> '__EMPTY__' AND all_msgs.label = p_label))
      AND (p_sentiment IS NULL OR (p_sentiment = '__EMPTY__' AND all_msgs.sentiment IS NULL) OR (p_sentiment <> '__EMPTY__' AND all_msgs.sentiment = p_sentiment))
  ),
  thread_stats AS (
    SELECT
      a.sender_email,
      a.campaign_id,
      COUNT(*)                                                  AS thread_count,
      BOOL_OR(a.read_status = 'unread' AND a.direction = 'IN') AS has_unread
    FROM all_msgs a
    WHERE EXISTS (
      SELECT 1 FROM filtered_in f
      WHERE f.sender_email = a.sender_email
        AND (f.campaign_id = a.campaign_id OR (f.campaign_id IS NULL AND a.campaign_id IS NULL))
    )
    GROUP BY a.sender_email, a.campaign_id
  ),
  latest AS (
    SELECT DISTINCT ON (f.sender_email, f.campaign_id) f.*
    FROM filtered_in f
    ORDER BY f.sender_email, f.campaign_id, f.replied_at DESC
  )
  SELECT
    l.id, l.tenant_id, l.campaign_id, l.campaign_name, l.sender_email,
    l.reply_body, l.replied_at, l.company_id, l.contact_id,
    l.match_status, l.read_status, l.category, l.category_confidence,
    l.raw_payload, l.created_at, l.updated_at,
    ts.thread_count, ts.has_unread,
    l.label, l.sentiment, l.subject
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

CREATE OR REPLACE FUNCTION count_email_reply_threads(
  p_tenant_id    UUID,
  p_campaign_id  TEXT        DEFAULT NULL,
  p_match_status TEXT        DEFAULT NULL,
  p_read_status  TEXT        DEFAULT NULL,
  p_search       TEXT        DEFAULT NULL,
  p_date_from    TIMESTAMPTZ DEFAULT NULL,
  p_date_to      TIMESTAMPTZ DEFAULT NULL,
  p_label        TEXT        DEFAULT NULL,
  p_sentiment    TEXT        DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered_in AS (
    SELECT sender_email, campaign_id, read_status
    FROM email_replies
    WHERE tenant_id = p_tenant_id
      AND direction = 'IN'
      AND (p_campaign_id  IS NULL OR campaign_id  = p_campaign_id)
      AND (p_match_status IS NULL OR match_status = p_match_status)
      AND (p_label IS NULL OR (p_label = '__EMPTY__' AND label IS NULL) OR (p_label <> '__EMPTY__' AND label = p_label))
      AND (p_sentiment IS NULL OR (p_sentiment = '__EMPTY__' AND sentiment IS NULL) OR (p_sentiment <> '__EMPTY__' AND sentiment = p_sentiment))
      AND (p_search       IS NULL
           OR sender_email ILIKE '%' || p_search || '%'
           OR reply_body   ILIKE '%' || p_search || '%')
      AND (p_date_from IS NULL OR replied_at >= p_date_from)
      AND (p_date_to   IS NULL OR replied_at <= p_date_to)
  ),
  thread_agg AS (
    SELECT
      sender_email,
      campaign_id,
      BOOL_OR(read_status = 'unread') AS has_unread
    FROM filtered_in
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
