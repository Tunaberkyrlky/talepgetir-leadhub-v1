-- ============================================================================
-- 045: Tekil mail (reply/forward/compose) open/click tracking
--
-- campaign_email_events bugüne kadar yalnızca drip kampanya maillerini
-- (activities üzerinden) izliyordu. Tekil gönderimler email_replies'a OUT
-- satırı olarak yazıldığından, event'lerin email_replies.id'ye de
-- bağlanabilmesi gerekiyor. activity_id nullable olur, email_reply_id
-- eklenir; her event en az birine bağlı olmak zorundadır.
-- ============================================================================

ALTER TABLE campaign_email_events ALTER COLUMN activity_id DROP NOT NULL;

ALTER TABLE campaign_email_events
    ADD COLUMN email_reply_id UUID REFERENCES email_replies(id) ON DELETE CASCADE;

ALTER TABLE campaign_email_events
    ADD CONSTRAINT campaign_email_events_target_check
    CHECK (activity_id IS NOT NULL OR email_reply_id IS NOT NULL);

CREATE INDEX idx_campaign_events_email_reply
    ON campaign_email_events(email_reply_id, event_type)
    WHERE email_reply_id IS NOT NULL;

-- RLS: tenant doğrulaması artık iki yoldan (activity VEYA email_reply)
DROP POLICY "Tenant via activity" ON campaign_email_events;

CREATE POLICY "Tenant via activity or reply" ON campaign_email_events
    FOR ALL USING (
        (activity_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM activities a
            WHERE a.id = campaign_email_events.activity_id
              AND a.tenant_id = get_user_tenant_id()))
        OR (email_reply_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM email_replies r
            WHERE r.id = campaign_email_events.email_reply_id
              AND r.tenant_id = get_user_tenant_id()))
    );

-- ── Toplu istatistik RPC'si ─────────────────────────────────────────────────
-- Taslak olmayan OUT mailler üzerinden: gönderilen, açılan (distinct mesaj),
-- tıklanan (distinct mesaj). Oranlar route katmanında hesaplanır.

CREATE OR REPLACE FUNCTION get_email_reply_tracking_stats(
    p_tenant_id uuid,
    p_date_from timestamptz DEFAULT NULL,
    p_date_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(sent bigint, opened bigint, clicked bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH outbound AS (
    -- Only mails that actually carried a tracking pixel (raw_payload.tracked).
    -- Tracking-öncesi gönderilen ve API_BASE_URL'siz (pixelsiz) OUT satırları
    -- asla open/click üretemez; paydaya katılırlarsa oranlar kalıcı düşük çıkar.
    SELECT id FROM email_replies
    WHERE tenant_id = p_tenant_id
      AND direction = 'OUT'
      AND raw_payload->>'tracked' = 'true'
      AND (p_date_from IS NULL OR replied_at >= p_date_from)
      AND (p_date_to   IS NULL OR replied_at <= p_date_to)
  )
  SELECT
    (SELECT COUNT(*) FROM outbound),
    (SELECT COUNT(DISTINCT e.email_reply_id) FROM campaign_email_events e
       JOIN outbound o ON o.id = e.email_reply_id
     WHERE e.event_type = 'open'),
    (SELECT COUNT(DISTINCT e.email_reply_id) FROM campaign_email_events e
       JOIN outbound o ON o.id = e.email_reply_id
     WHERE e.event_type = 'click');
$$;

-- ── EXECUTE izinleri ─────────────────────────────────────────────────────────
-- Bu RPC'ler yalnızca sunucudan supabaseAdmin (service_role) ile çağrılır;
-- doğrudan PostgREST üzerinden erişim cross-tenant sızıntısı olur (020 kalıbı).
REVOKE ALL ON FUNCTION get_email_reply_tracking_stats(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_email_reply_tracking_stats(uuid, timestamptz, timestamptz) TO service_role;

-- get_email_reply_threads, 028'den beri (CREATE OR REPLACE ile imza değişince)
-- 026'daki REVOKE'u kaybetmiş ve anon EXECUTE'a açık kalmış: anon key + tenant
-- UUID ile herhangi bir tenant'ın tam mail satırları okunabiliyordu. Burada kapatılır.
REVOKE ALL ON FUNCTION get_email_reply_threads(uuid, integer, integer, text, text, text, text, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_email_reply_threads(uuid, integer, integer, text, text, text, text, timestamptz, timestamptz, text, text) TO service_role;
