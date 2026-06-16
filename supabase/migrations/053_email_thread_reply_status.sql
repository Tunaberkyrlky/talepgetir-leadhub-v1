-- ============================================================================
-- 053: Liste satırına "yanıt durumu" alanları (last_direction + awaiting)
--
-- Mail listesi (get_email_reply_threads) zaten thread_stats içinde son mesajın
-- yönünü (last_direction) ve "yanıt bekliyor mu" bilgisini hesaplıyor ama yalnızca
-- p_awaiting filtresinde kullanıyordu; satır çıktısında dönmüyordu. UI'da her satır
-- için tek bakışlık durum göstergesi (yanıt bekliyor → saat, son söz bizde → yeşil tik)
-- çizebilmek için bu iki alanı RETURNS TABLE'a ekliyoruz.
--
-- awaiting predikatı 049'daki tek-kaynak email_reply_awaiting() helper'ından gelir
-- (drift yok). count_email_reply_threads değişmez (bigint döner).
-- Return type değiştiği için CREATE OR REPLACE yetmez → DROP + CREATE; REVOKE/GRANT
-- yeniden uygulanır (045 kalıbı).
-- ============================================================================

DROP FUNCTION IF EXISTS get_email_reply_threads(uuid,integer,integer,text,text,text,text,timestamptz,timestamptz,text,text,boolean);
-- Eski, hiç düşürülmemiş 9-argümanlı overload (p_label/p_sentiment öncesi). Server artık
-- yalnızca 12-argümanlı sürümü çağırıyor; bu ölü overload kalınca 3-arg çağrılar belirsiz oluyor.
DROP FUNCTION IF EXISTS get_email_reply_threads(uuid,integer,integer,text,text,text,text,timestamptz,timestamptz);

CREATE FUNCTION get_email_reply_threads(
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
  account_email text, from_address text, to_address text, cc_address text, provider text,
  last_direction text, awaiting boolean
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
    l.account_email, l.from_address, l.to_address, l.cc_address, l.provider,
    ts.last_direction,
    email_reply_awaiting(ts.last_direction, ts.last_label) AS awaiting
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

REVOKE ALL ON FUNCTION get_email_reply_threads(uuid,integer,integer,text,text,text,text,timestamptz,timestamptz,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_email_reply_threads(uuid,integer,integer,text,text,text,text,timestamptz,timestamptz,text,text,boolean) TO service_role;
