-- ============================================================================
-- 049: "Yanıt Bekleyen" mantığını tek yere topla (drift önleme)
--
-- awaiting tanımı ("son söz karşı tarafta + otomatik değil") şu ana kadar 3 yerde
-- elle kopyalanıyordu: get_email_reply_stats (kart sayısı), get_email_reply_threads
-- ve count_email_reply_threads (liste + sayfa sayısı). Bir auto-reply etiketi
-- eklenince üçünü de güncellemek gerekiyordu; biri unutulursa kart sayısı ile
-- liste satır sayısı yeniden sapardı (daha önce yaşandı).
--
-- Çözüm: predikatı tek bir IMMUTABLE yardımcıya al; üç fonksiyon da onu çağırsın.
-- Davranış BİREBİR aynı (üç-değerli NULL mantığı dahil) — sadece tek kaynak.
--
-- İmza/return type değişmediği için CREATE OR REPLACE yeterli (atomik, DROP
-- penceresi yok, mevcut REVOKE/GRANT korunur).
-- ============================================================================

CREATE OR REPLACE FUNCTION email_reply_awaiting(p_last_direction text, p_last_label text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $function$
  -- Thread'in son mesajı IN (top karşı tarafta) ve otomatik bir yanıt değilse:
  -- bizden yanıt bekliyor demektir.
  SELECT p_last_direction = 'IN'
     AND (p_last_label IS NULL OR p_last_label NOT IN ('AUTOMATIC_REPLY', 'OUT_OF_OFFICE'));
$function$;

-- Yalnızca diğer SECURITY DEFINER fonksiyonların içinden (definer hakkıyla) çağrılır;
-- doğrudan erişime gerek yok. 020 kalıbı.
REVOKE ALL ON FUNCTION email_reply_awaiting(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION email_reply_awaiting(text, text) TO service_role;

-- ── get_email_reply_stats: awaiting kartı predikatı helper'a ──
CREATE OR REPLACE FUNCTION get_email_reply_stats(
  p_tenant_id uuid,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(
  total bigint, unread bigint, matched bigint, unmatched bigint,
  interested bigint, awaiting bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH all_msgs AS (
    SELECT * FROM email_replies
    WHERE tenant_id = p_tenant_id
      AND (raw_payload IS NULL OR raw_payload->>'source' IS DISTINCT FROM 'draft')
      AND (p_date_from IS NULL OR replied_at >= p_date_from)
      AND (p_date_to   IS NULL OR replied_at <= p_date_to)
  ),
  thread_stats AS (
    SELECT sender_email, campaign_id,
      BOOL_OR(read_status = 'unread' AND direction = 'IN') AS has_unread,
      (array_agg(direction ORDER BY replied_at DESC))[1] AS last_direction,
      (array_agg(label     ORDER BY replied_at DESC))[1] AS last_label
    FROM all_msgs GROUP BY sender_email, campaign_id
  ),
  latest AS (
    SELECT DISTINCT ON (sender_email, campaign_id) sender_email, campaign_id, match_status, label
    FROM all_msgs
    ORDER BY sender_email, campaign_id, (direction = 'IN') DESC, replied_at DESC
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE ts.has_unread),
    COUNT(*) FILTER (WHERE l.match_status = 'matched'),
    COUNT(*) FILTER (WHERE l.match_status = 'unmatched'),
    COUNT(*) FILTER (WHERE l.label = 'INTERESTED'),
    COUNT(*) FILTER (WHERE email_reply_awaiting(ts.last_direction, ts.last_label))
  FROM latest l
  JOIN thread_stats ts
    ON ts.sender_email = l.sender_email
   AND (ts.campaign_id = l.campaign_id OR (ts.campaign_id IS NULL AND l.campaign_id IS NULL));
$function$;

-- ── get_email_reply_threads: p_awaiting filtresi predikatı helper'a ──
CREATE OR REPLACE FUNCTION get_email_reply_threads(
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
  p_sentiment text DEFAULT NULL,
  p_awaiting boolean DEFAULT false
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
      AND (p_search IS NULL OR sender_email ILIKE '%' || p_search || '%' OR reply_body ILIKE '%' || p_search || '%')
      AND (p_date_from IS NULL OR replied_at >= p_date_from)
      AND (p_date_to   IS NULL OR replied_at <= p_date_to)
  ),
  thread_stats AS (
    SELECT sender_email, campaign_id,
      COUNT(*) AS thread_count,
      BOOL_OR(read_status = 'unread' AND direction = 'IN') AS has_unread,
      (array_agg(direction ORDER BY replied_at DESC))[1] AS last_direction,
      (array_agg(label     ORDER BY replied_at DESC))[1] AS last_label
    FROM all_msgs GROUP BY sender_email, campaign_id
  ),
  latest AS (
    SELECT DISTINCT ON (a.sender_email, a.campaign_id) a.*
    FROM all_msgs a
    ORDER BY a.sender_email, a.campaign_id, (a.direction = 'IN') DESC, a.replied_at DESC
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
   AND (ts.campaign_id = l.campaign_id OR (ts.campaign_id IS NULL AND l.campaign_id IS NULL))
  WHERE (p_match_status IS NULL OR l.match_status = p_match_status)
    AND (p_label IS NULL OR (p_label = '__EMPTY__' AND l.label IS NULL) OR (p_label <> '__EMPTY__' AND l.label = p_label))
    AND (p_sentiment IS NULL OR (p_sentiment = '__EMPTY__' AND l.sentiment IS NULL) OR (p_sentiment <> '__EMPTY__' AND l.sentiment = p_sentiment))
    AND (p_read_status IS NULL OR (p_read_status = 'unread' AND ts.has_unread) OR (p_read_status = 'read' AND NOT ts.has_unread))
    AND (NOT p_awaiting OR email_reply_awaiting(ts.last_direction, ts.last_label))
  ORDER BY l.replied_at DESC
  LIMIT p_limit OFFSET p_offset;
$function$;

-- ── count_email_reply_threads: aynı p_awaiting filtresi helper'a ──
CREATE OR REPLACE FUNCTION count_email_reply_threads(
  p_tenant_id uuid,
  p_campaign_id text DEFAULT NULL,
  p_match_status text DEFAULT NULL,
  p_read_status text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_label text DEFAULT NULL,
  p_sentiment text DEFAULT NULL,
  p_awaiting boolean DEFAULT false
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH all_msgs AS (
    SELECT *
    FROM email_replies
    WHERE tenant_id = p_tenant_id
      AND (raw_payload IS NULL OR raw_payload->>'source' IS DISTINCT FROM 'draft')
      AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id)
      AND (p_search IS NULL OR sender_email ILIKE '%' || p_search || '%' OR reply_body ILIKE '%' || p_search || '%')
      AND (p_date_from IS NULL OR replied_at >= p_date_from)
      AND (p_date_to   IS NULL OR replied_at <= p_date_to)
  ),
  thread_stats AS (
    SELECT sender_email, campaign_id,
      BOOL_OR(read_status = 'unread' AND direction = 'IN') AS has_unread,
      (array_agg(direction ORDER BY replied_at DESC))[1] AS last_direction,
      (array_agg(label     ORDER BY replied_at DESC))[1] AS last_label
    FROM all_msgs GROUP BY sender_email, campaign_id
  ),
  latest AS (
    SELECT DISTINCT ON (a.sender_email, a.campaign_id) a.*
    FROM all_msgs a
    ORDER BY a.sender_email, a.campaign_id, (a.direction = 'IN') DESC, a.replied_at DESC
  )
  SELECT COUNT(*)
  FROM latest l
  JOIN thread_stats ts
    ON ts.sender_email = l.sender_email
   AND (ts.campaign_id = l.campaign_id OR (ts.campaign_id IS NULL AND l.campaign_id IS NULL))
  WHERE (p_match_status IS NULL OR l.match_status = p_match_status)
    AND (p_label IS NULL OR (p_label = '__EMPTY__' AND l.label IS NULL) OR (p_label <> '__EMPTY__' AND l.label = p_label))
    AND (p_sentiment IS NULL OR (p_sentiment = '__EMPTY__' AND l.sentiment IS NULL) OR (p_sentiment <> '__EMPTY__' AND l.sentiment = p_sentiment))
    AND (p_read_status IS NULL OR (p_read_status = 'unread' AND ts.has_unread) OR (p_read_status = 'read' AND NOT ts.has_unread))
    AND (NOT p_awaiting OR email_reply_awaiting(ts.last_direction, ts.last_label));
$function$;
