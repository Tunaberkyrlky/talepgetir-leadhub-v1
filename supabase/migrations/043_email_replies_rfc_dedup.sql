-- ============================================================================
-- 043: RFC Message-ID dedup for IMAP-ingested replies
--
-- IMAP mailleri campaign_id=NULL olduğu için mevcut dedup index'i
-- (campaign_id, sender_email, replied_at WHERE campaign_id IS NOT NULL)
-- çalışmaz. RFC 2822 Message-ID globally unique olduğundan, IMAP/inbound
-- dedup'ı bunun üzerinden yapılır.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_replies_rfc_dedup
  ON email_replies (tenant_id, rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;
