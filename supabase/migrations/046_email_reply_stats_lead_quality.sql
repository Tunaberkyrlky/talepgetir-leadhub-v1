-- ============================================================================
-- 046: get_email_reply_stats — lead kalitesi + yanıt bekleyen metrikleri
--
-- Email Yanıtları kartları "kaç gelen var" yerine iş akışı odağına geçiyor:
-- kaçı ilgileniyor, kaçı hâlâ benden yanıt bekliyor. Mevcut total/unread/
-- matched/unmatched korunur (geriye uyum); interested + awaiting eklenir.
--
-- Return type değiştiği için CREATE OR REPLACE yetmez → DROP + CREATE. DROP,
-- 022'deki REVOKE'u da siler; bu yüzden REVOKE/GRANT yeniden uygulanır (020 kalıbı).
--
-- p_date_from/p_date_to: kartlar sayfa üstündeki Gün/Hafta/Ay/Özel seçicisine
-- bağlanır (replied_at aralığı). NULL → tüm zaman (geriye uyumlu).
--
-- ÖNEMLİ: bu RPC, get_email_reply_threads / count_email_reply_threads (044/047)
-- ile BİREBİR aynı thread/temsilci/has_unread/last_direction mantığını kullanır.
-- Böylece bir kartın sayısı = o kart tıklanınca listede çıkan satır sayısı.
-- (Eski sürüm IN-only thread + son-IN-temsilci kullanıyordu, liste ile sapıyordu.)
-- ============================================================================

DROP FUNCTION IF EXISTS get_email_reply_stats(uuid);

CREATE FUNCTION get_email_reply_stats(
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
    -- liste RPC'siyle aynı evren: tüm mesajlar (IN+OUT), taslak hariç, tarih filtreli
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
    -- temsilci: IN-öncelikli (PlusVibe label/sentiment gelen mailden gelir)
    SELECT DISTINCT ON (sender_email, campaign_id) sender_email, campaign_id, match_status, label
    FROM all_msgs
    ORDER BY sender_email, campaign_id, (direction = 'IN') DESC, replied_at DESC
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE ts.has_unread),
    COUNT(*) FILTER (WHERE l.match_status = 'matched'),
    COUNT(*) FILTER (WHERE l.match_status = 'unmatched'),
    -- İlgilenen: thread temsilcisinin etiketi INTERESTED
    COUNT(*) FILTER (WHERE l.label = 'INTERESTED'),
    -- Yanıt bekleyen: son söz karşı tarafta (en son mesaj IN) ve otomatik değil
    COUNT(*) FILTER (WHERE ts.last_direction = 'IN'
      AND (ts.last_label IS NULL OR ts.last_label NOT IN ('AUTOMATIC_REPLY', 'OUT_OF_OFFICE')))
  FROM latest l
  JOIN thread_stats ts
    ON ts.sender_email = l.sender_email
   AND (ts.campaign_id = l.campaign_id OR (ts.campaign_id IS NULL AND l.campaign_id IS NULL));
$function$;

REVOKE ALL ON FUNCTION get_email_reply_stats(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_email_reply_stats(uuid, timestamptz, timestamptz) TO service_role;
