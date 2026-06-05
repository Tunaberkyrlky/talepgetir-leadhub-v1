-- ==========================================
-- get_email_reply_threads — return canonical address columns
-- ==========================================
-- Adds account_email / from_address / to_address / cc_address / provider to the
-- thread list so the client reads the canonical "From" from columns (not
-- raw_payload heuristics). Body unchanged except the final SELECT column list.

DROP FUNCTION IF EXISTS public.get_email_reply_threads(uuid,integer,integer,text,text,text,text,timestamptz,timestamptz,text,text);

CREATE OR REPLACE FUNCTION public.get_email_reply_threads(
  p_tenant_id uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20,
  p_campaign_id text DEFAULT NULL,
  p_match_status text DEFAULT NULL,
  p_read_status text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_label text DEFAULT NULL,
  p_sentiment text DEFAULT NULL
)
RETURNS TABLE(
  id uuid, tenant_id uuid, campaign_id text, campaign_name text, sender_email text,
  reply_body text, replied_at timestamptz, company_id uuid, contact_id uuid,
  match_status text, read_status text, category text, category_confidence real,
  raw_payload jsonb, created_at timestamptz, updated_at timestamptz,
  thread_count bigint, has_unread boolean, label text, sentiment text, subject text,
  account_email text, from_address text, to_address text, cc_address text, provider text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH all_msgs AS (
    SELECT *
    FROM email_replies
    WHERE tenant_id = p_tenant_id
      AND (raw_payload IS NULL OR raw_payload->>'source' IS DISTINCT FROM 'draft')
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
    l.label, l.sentiment, l.subject,
    l.account_email, l.from_address, l.to_address, l.cc_address, l.provider
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
$function$;
