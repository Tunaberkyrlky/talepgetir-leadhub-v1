-- ============================================================================
-- 062: Liste doğrulama (deliverability — task-4)
-- Gönderim öncesi doğrulama (sözdizimi / MX / disposable) geçersiz alıcıları
-- SESSİZ bounce yerine 'skipped_invalid' durumuyla işaretler → istatistikte
-- görünür, zamanlayıcı almaz, gönderen kutu itibarı korunur.
--
-- Belirsiz (DNS timeout/servfail) alanlar FAIL-OPEN → normal kaydedilir; bu
-- durum yalnız KESİN geçersiz kutuları eler.
--
-- Geriye-uyumluluk: mevcut kayıtlar etkilenmez; yeni durum/kolon eklenir.
-- ============================================================================

-- Neden alanı: 'syntax' | 'no_mx' | 'disposable' (skipped_invalid kayıtlarında dolu;
-- gönderim-anı atlamalarında da yazılır). Diğer durumlarda NULL.
ALTER TABLE campaign_enrollments
    ADD COLUMN IF NOT EXISTS skip_reason TEXT;

-- status CHECK'ine 'skipped_invalid' eklenir. 032'deki inline kısıt otomatik
-- 'campaign_enrollments_status_check' adını aldığından onu düşürüp yeniden kurarız.
ALTER TABLE campaign_enrollments
    DROP CONSTRAINT IF EXISTS campaign_enrollments_status_check;

ALTER TABLE campaign_enrollments
    ADD CONSTRAINT campaign_enrollments_status_check
    CHECK (status IN (
        'active', 'completed', 'paused',
        'replied', 'bounced', 'unsubscribed',
        'skipped_invalid'
    ));
